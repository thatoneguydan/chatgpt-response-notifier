using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class HiddenWindowIncidentRetention
{
    private const int MaxIncidents = 20;
    private const int MaxMetadataBytes = 128 * 1024;
    private const long CorrelationGraceMs = 10 * 60 * 1000;
    private readonly List<JsonElement> _incidents = new();
    private readonly Dictionary<string, TraceVerdict> _verdicts = new(StringComparer.Ordinal);
    private readonly HashSet<string> _pageBridgeDocuments = new(StringComparer.Ordinal);
    private readonly HashSet<string> _mainObserverDocuments = new(StringComparer.Ordinal);
    private readonly HashSet<int> _attachmentFailureTabs = new();
    private readonly Dictionary<string, string> _deliveryCorrelationIndex = new(StringComparer.Ordinal);
    private int _hostEvictions;
    private int _uncorrelatedBoundaryEvents;

    private sealed class TraceVerdict
    {
        public string IncidentId { get; init; } = string.Empty;
        public string FirstMissingBoundary { get; set; } = "none";
        public string ObservationBoundary { get; set; } = "none";
        public string ActionState { get; set; } = "none";
        public string ActionReason { get; set; } = string.Empty;
        public string DeliveryState { get; set; } = "none";
        public string DeliveryReason { get; set; } = string.Empty;
        public string DeliveryCorrelationSuffix { get; set; } = string.Empty;
        public string CorrelationConfidence { get; set; } = string.Empty;
        public string UpdatedAtUtc { get; set; } = string.Empty;
    }

    public bool TryUpsert(JsonElement diagnostic)
    {
        if (diagnostic.ValueKind != JsonValueKind.Object) return false;
        var source = StringValue(diagnostic, "source", 40) ?? string.Empty;
        var status = StringValue(diagnostic, "status", 96) ?? string.Empty;

        if (source == "hidden-window-diagnostics")
        {
            TrackAttachment(status, diagnostic);
            if (status != "incident-snapshot") return false;
            if (!diagnostic.TryGetProperty("incident", out var incident) || incident.ValueKind != JsonValueKind.Object) return false;
            var id = StringValue(incident, "incidentId", 80);
            if (string.IsNullOrWhiteSpace(id)) return false;

            for (var index = _incidents.Count - 1; index >= 0; index--)
            {
                if (string.Equals(StringValue(_incidents[index], "incidentId", 80), id, StringComparison.Ordinal))
                    _incidents.RemoveAt(index);
            }
            _incidents.Add(incident.Clone());
            RefreshVerdict(incident, preserveExternalState: true);
            Trim();
            return true;
        }

        if (source == "recovery-decision")
        {
            ApplyRecoveryDecision(diagnostic);
            return false;
        }

        if (source == "delivery-pipeline")
        {
            ApplyDeliveryEvent(diagnostic);
            return false;
        }

        return false;
    }

    public void Load(JsonElement root)
    {
        _incidents.Clear();
        _verdicts.Clear();
        _pageBridgeDocuments.Clear();
        _mainObserverDocuments.Clear();
        _attachmentFailureTabs.Clear();
        _deliveryCorrelationIndex.Clear();
        _hostEvictions = 0;
        _uncorrelatedBoundaryEvents = 0;
        if (!root.TryGetProperty("hiddenWindowDiagnostics", out var hidden) || hidden.ValueKind != JsonValueKind.Object) return;
        _hostEvictions = (int)Math.Clamp(IntegerValue(hidden, "hostEvictions") ?? 0, 0, int.MaxValue);
        _uncorrelatedBoundaryEvents = (int)Math.Clamp(IntegerValue(hidden, "uncorrelatedBoundaryEvents") ?? 0, 0, int.MaxValue);
        if (hidden.TryGetProperty("incidents", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray().TakeLast(MaxIncidents))
            {
                if (item.ValueKind == JsonValueKind.Object) _incidents.Add(item.Clone());
            }
        }
        if (hidden.TryGetProperty("verdicts", out var verdicts) && verdicts.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in verdicts.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                var id = StringValue(item, "incidentId", 80);
                if (string.IsNullOrWhiteSpace(id)) continue;
                var verdict = new TraceVerdict
                {
                    IncidentId = id,
                    FirstMissingBoundary = StringValue(item, "firstMissingBoundary", 96) ?? "none",
                    ObservationBoundary = StringValue(item, "observationBoundary", 96) ?? "none",
                    ActionState = StringValue(item, "actionState", 48) ?? "none",
                    ActionReason = StringValue(item, "actionReason", 160) ?? string.Empty,
                    DeliveryState = StringValue(item, "deliveryState", 48) ?? "none",
                    DeliveryReason = StringValue(item, "deliveryReason", 160) ?? string.Empty,
                    DeliveryCorrelationSuffix = StringValue(item, "deliveryCorrelationSuffix", 8) ?? string.Empty,
                    CorrelationConfidence = StringValue(item, "correlationConfidence", 48) ?? string.Empty,
                    UpdatedAtUtc = StringValue(item, "updatedAtUtc", 64) ?? string.Empty
                };
                _verdicts[id] = verdict;
                if (!string.IsNullOrWhiteSpace(verdict.DeliveryCorrelationSuffix))
                    _deliveryCorrelationIndex[verdict.DeliveryCorrelationSuffix] = id;
            }
        }
        foreach (var incident in _incidents)
        {
            var id = StringValue(incident, "incidentId", 80);
            if (!string.IsNullOrWhiteSpace(id) && !_verdicts.ContainsKey(id)) RefreshVerdict(incident);
        }
        Trim();
    }

    public object Snapshot() => new
    {
        schemaVersion = 1,
        correlatedTraceVersion = 1,
        maxIncidents = MaxIncidents,
        maxTransitionsPerIncident = 48,
        maxMetadataBytes = MaxMetadataBytes,
        incidentCount = _incidents.Count,
        metadataBytes = MetadataBytes(),
        hostEvictions = _hostEvictions,
        uncorrelatedBoundaryEvents = _uncorrelatedBoundaryEvents,
        incidents = _incidents.ToArray(),
        verdicts = _incidents.Select(item =>
        {
            var id = StringValue(item, "incidentId", 80) ?? string.Empty;
            var verdict = VerdictFor(id);
            return new
            {
                incidentId = id,
                firstMissingBoundary = verdict.FirstMissingBoundary,
                observationBoundary = verdict.ObservationBoundary,
                actionState = verdict.ActionState,
                actionReason = verdict.ActionReason,
                deliveryState = verdict.DeliveryState,
                deliveryReason = verdict.DeliveryReason,
                deliveryCorrelationSuffix = verdict.DeliveryCorrelationSuffix,
                correlationConfidence = verdict.CorrelationConfidence,
                updatedAtUtc = verdict.UpdatedAtUtc
            };
        }).ToArray()
    };

    private void TrackAttachment(string status, JsonElement diagnostic)
    {
        if (status == "existing-tab-diagnostics-attach-error")
        {
            var tabId = IntegerValue(diagnostic, "tabId");
            if (tabId.HasValue && tabId.Value >= 0 && tabId.Value <= int.MaxValue) _attachmentFailureTabs.Add((int)tabId.Value);
            return;
        }

        var documentSuffix = StringValue(diagnostic, "chromeDocumentSuffix", 8) ?? string.Empty;
        if (string.IsNullOrWhiteSpace(documentSuffix)) return;
        if (status == "page-bridge-installed") _pageBridgeDocuments.Add(documentSuffix);
        if (status == "main-observer-installed") _mainObserverDocuments.Add(documentSuffix);
        if (status is "page-bridge-installed" or "main-observer-installed")
        {
            foreach (var incident in _incidents.Where(item => StringValue(item, "chromeDocumentSuffix", 8) == documentSuffix))
                RefreshVerdict(incident, preserveExternalState: true);
        }
    }

    private void ApplyRecoveryDecision(JsonElement diagnostic)
    {
        var match = FindIncident(diagnostic, allowDeliveryCorrelation: false);
        if (match.id is null)
        {
            _uncorrelatedBoundaryEvents++;
            return;
        }
        var verdict = VerdictFor(match.id);
        var status = StringValue(diagnostic, "status", 96) ?? "decision";
        var reason = StringValue(diagnostic, "reason", 160) ?? string.Empty;
        var decisionState = StringValue(diagnostic, "decisionState", 48) ?? string.Empty;
        var uncertain = BooleanValue(diagnostic, "uncertain") == true;
        verdict.ActionState = status switch
        {
            "action-admitted" => "admitted",
            "action-blocked" => "blocked",
            "action-finished" when uncertain => "uncertain",
            "action-finished" => "finished",
            "post-reload-decision" when decisionState == "attention" => "held",
            "post-reload-decision" => "post-reload",
            "candidate" => "candidate",
            _ => status
        };
        verdict.ActionReason = reason;
        if (verdict.FirstMissingBoundary == "none")
        {
            if (verdict.ActionState == "blocked") verdict.FirstMissingBoundary = "recovery-veto";
            else if (verdict.ActionState == "held") verdict.FirstMissingBoundary = "recovery-hold";
            else if (verdict.ActionState == "uncertain") verdict.FirstMissingBoundary = "recovery-uncertain";
        }
        verdict.CorrelationConfidence = match.confidence;
        verdict.UpdatedAtUtc = StringValue(diagnostic, "observedAt", 64) ?? DateTimeOffset.UtcNow.ToString("O");
    }

    private void ApplyDeliveryEvent(JsonElement diagnostic)
    {
        var status = StringValue(diagnostic, "status", 96) ?? string.Empty;
        var correlationSuffix = Suffix(StringValue(diagnostic, "correlationId", 80));
        var match = FindIncident(diagnostic, allowDeliveryCorrelation: true);
        if (match.id is null)
        {
            _uncorrelatedBoundaryEvents++;
            return;
        }
        var verdict = VerdictFor(match.id);
        if (!string.IsNullOrWhiteSpace(correlationSuffix))
        {
            verdict.DeliveryCorrelationSuffix = correlationSuffix;
            _deliveryCorrelationIndex[correlationSuffix] = match.id;
        }

        var reason = StringValue(diagnostic, "reason", 160) ?? string.Empty;
        verdict.DeliveryState = status switch
        {
            "notification-queue-start" => "queueing",
            "notification-durable-queued" => "queued",
            "outbox-send-attempt" => "sending",
            "helper-durable-accepted" => "accepted",
            "helper-ack-missing" => "failed",
            "notification-queue-error" => "failed",
            "outbox-attention" => "failed",
            "notification-suppressed-owner-tab-closed" => "suppressed",
            _ => verdict.DeliveryState
        };
        if (!string.IsNullOrWhiteSpace(reason)) verdict.DeliveryReason = reason;
        if (string.IsNullOrWhiteSpace(verdict.ActionReason) && status == "notification-queue-start" && !string.IsNullOrWhiteSpace(reason))
            verdict.ActionReason = reason;
        if (verdict.DeliveryState == "failed" && verdict.FirstMissingBoundary == "none")
            verdict.FirstMissingBoundary = "delivery-failure";
        verdict.CorrelationConfidence = match.confidence;
        verdict.UpdatedAtUtc = StringValue(diagnostic, "observedAt", 64) ?? DateTimeOffset.UtcNow.ToString("O");
    }

    private (string? id, string confidence) FindIncident(JsonElement diagnostic, bool allowDeliveryCorrelation)
    {
        if (allowDeliveryCorrelation)
        {
            var correlationSuffix = Suffix(StringValue(diagnostic, "correlationId", 80));
            if (!string.IsNullOrWhiteSpace(correlationSuffix) && _deliveryCorrelationIndex.TryGetValue(correlationSuffix, out var correlatedId))
                return (correlatedId, "delivery-correlation");
        }

        var requestSuffix = StringValue(diagnostic, "requestSuffix", 8) ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(requestSuffix))
        {
            var exact = _incidents.LastOrDefault(item => StringValue(item, "requestSuffix", 8) == requestSuffix);
            if (exact.ValueKind == JsonValueKind.Object) return (StringValue(exact, "incidentId", 80), "request-suffix-exact");
        }

        var documentSuffix = StringValue(diagnostic, "chromeDocumentSuffix", 8) ?? string.Empty;
        if (string.IsNullOrWhiteSpace(documentSuffix)) return (null, string.Empty);
        var eventMs = ObservedAtMilliseconds(diagnostic);
        var candidates = _incidents
            .Where(item => StringValue(item, "chromeDocumentSuffix", 8) == documentSuffix)
            .Select(item => new
            {
                item,
                started = IntegerValue(item, "startedAt") ?? 0,
                settled = IntegerValue(item, "settledAt") ?? 0
            })
            .Where(value => value.started <= eventMs + 5000)
            .Where(value => value.settled == 0 || eventMs <= value.settled + CorrelationGraceMs)
            .OrderBy(value => Math.Abs(eventMs - (value.settled > 0 ? value.settled : value.started)))
            .ToArray();
        if (candidates.Length == 0) return (null, string.Empty);
        var id = StringValue(candidates[0].item, "incidentId", 80);
        return (id, candidates.Length == 1 ? "document-time-unique" : "document-time-nearest");
    }

    private void RefreshVerdict(JsonElement incident, bool preserveExternalState = false)
    {
        var id = StringValue(incident, "incidentId", 80);
        if (string.IsNullOrWhiteSpace(id)) return;
        var verdict = VerdictFor(id);
        var existingActionState = verdict.ActionState;
        var existingActionReason = verdict.ActionReason;
        var existingDeliveryState = verdict.DeliveryState;
        var existingDeliveryReason = verdict.DeliveryReason;
        var existingDeliveryCorrelation = verdict.DeliveryCorrelationSuffix;
        var existingCorrelationConfidence = verdict.CorrelationConfidence;
        var existingUpdatedAt = verdict.UpdatedAtUtc;

        var existingFirstMissingBoundary = verdict.FirstMissingBoundary;
        var rawBoundary = StringValue(incident, "firstUnresolvedBoundary", 96) ?? string.Empty;
        verdict.FirstMissingBoundary = string.IsNullOrWhiteSpace(rawBoundary)
            ? preserveExternalState && existingFirstMissingBoundary != "none" ? existingFirstMissingBoundary : "none"
            : rawBoundary;
        verdict.ObservationBoundary = ObservationBoundary(incident, rawBoundary);

        if (preserveExternalState)
        {
            verdict.ActionState = existingActionState;
            verdict.ActionReason = existingActionReason;
            verdict.DeliveryState = existingDeliveryState;
            verdict.DeliveryReason = existingDeliveryReason;
            verdict.DeliveryCorrelationSuffix = existingDeliveryCorrelation;
            verdict.CorrelationConfidence = existingCorrelationConfidence;
            verdict.UpdatedAtUtc = existingUpdatedAt;
        }
    }

    private string ObservationBoundary(JsonElement incident, string rawBoundary)
    {
        var documentSuffix = StringValue(incident, "chromeDocumentSuffix", 8) ?? string.Empty;
        var tabId = IntegerValue(incident, "tabId");
        var pageReplyObserved = false;
        var streamObserved = false;

        if (incident.TryGetProperty("transitions", out var transitions) && transitions.ValueKind == JsonValueKind.Array)
        {
            foreach (var transition in transitions.EnumerateArray().OrderBy(item => IntegerValue(item, "sequence") ?? long.MaxValue))
            {
                if (BooleanValue(transition, "tabDiscarded") == true) return "tab-discarded";
                if (BooleanValue(transition, "tabFrozen") == true) return "tab-frozen";
                if (BooleanValue(transition, "pageFrozen") == true) return "page-frozen";
                var stage = StringValue(transition, "stage", 64) ?? string.Empty;
                if (stage == "page-query-replied" || stage.StartsWith("page-", StringComparison.Ordinal) && stage is not "page-query-error" and not "page-query-deadline")
                    pageReplyObserved = true;
                if (stage.StartsWith("stream-", StringComparison.Ordinal)) streamObserved = true;
                if (stage == "page-query-deadline") return "page-query-deadline";
            }
        }

        if (rawBoundary == "page-query-error")
        {
            if (pageReplyObserved || _pageBridgeDocuments.Contains(documentSuffix)) return "page-query-error";
            if (tabId.HasValue && tabId.Value >= 0 && tabId.Value <= int.MaxValue && _attachmentFailureTabs.Contains((int)tabId.Value))
                return "page-diagnostic-attachment-failed";
            return "page-runtime-or-attachment-unavailable";
        }
        if (rawBoundary == "stream-final-not-observed")
        {
            if (streamObserved || _mainObserverDocuments.Contains(documentSuffix)) return "stream-final-not-observed";
            return "main-stream-observer-unconfirmed";
        }
        if (rawBoundary == "page-query-deadline") return "page-query-deadline";
        return string.IsNullOrWhiteSpace(rawBoundary) ? "none" : rawBoundary;
    }

    private TraceVerdict VerdictFor(string incidentId)
    {
        if (_verdicts.TryGetValue(incidentId, out var existing)) return existing;
        var verdict = new TraceVerdict { IncidentId = incidentId };
        _verdicts[incidentId] = verdict;
        return verdict;
    }

    private void Trim()
    {
        while (_incidents.Count > MaxIncidents || MetadataBytes() > MaxMetadataBytes)
        {
            if (_incidents.Count == 0) break;
            var oldest = _incidents[0];
            _incidents.RemoveAt(0);
            var id = StringValue(oldest, "incidentId", 80);
            if (!string.IsNullOrWhiteSpace(id))
            {
                _verdicts.Remove(id);
                foreach (var key in _deliveryCorrelationIndex.Where(pair => pair.Value == id).Select(pair => pair.Key).ToArray())
                    _deliveryCorrelationIndex.Remove(key);
            }
            _hostEvictions++;
        }
    }

    private int MetadataBytes()
    {
        try
        {
            var projection = new
            {
                incidents = _incidents,
                verdicts = _incidents.Select(item =>
                {
                    var id = StringValue(item, "incidentId", 80) ?? string.Empty;
                    var verdict = VerdictFor(id);
                    return new
                    {
                        verdict.IncidentId,
                        verdict.FirstMissingBoundary,
                        verdict.ObservationBoundary,
                        verdict.ActionState,
                        verdict.ActionReason,
                        verdict.DeliveryState,
                        verdict.DeliveryReason,
                        verdict.DeliveryCorrelationSuffix,
                        verdict.CorrelationConfidence,
                        verdict.UpdatedAtUtc
                    };
                })
            };
            return JsonSerializer.SerializeToUtf8Bytes(projection, JsonOptions.Default).Length;
        }
        catch { return MaxMetadataBytes + 1; }
    }

    private static long ObservedAtMilliseconds(JsonElement diagnostic)
    {
        var value = StringValue(diagnostic, "observedAt", 64);
        return DateTimeOffset.TryParse(value, out var parsed) ? parsed.ToUnixTimeMilliseconds() : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static string Suffix(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length == 0) return string.Empty;
        return text.Length <= 8 ? text : text[^8..];
    }

    private static string? StringValue(JsonElement root, string name, int maxLength)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.String) return null;
        var value = (node.GetString() ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
        if (value.Length == 0) return null;
        return value.Length <= maxLength ? value : value[..maxLength];
    }

    private static long? IntegerValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node)
            && node.ValueKind == JsonValueKind.Number
            && node.TryGetInt64(out var value)
                ? value
                : null;
    }

    private static bool? BooleanValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node)) return null;
        return node.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }
}
