using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal static class DiagnosticsSanitizer
{
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

    private static object? TerminalState(JsonElement root)
    {
        if (!root.TryGetProperty("terminalState", out var terminal) || terminal.ValueKind != JsonValueKind.Object) return null;
        var ancestry = new List<object>();
        if (terminal.TryGetProperty("ancestry", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
        {
            foreach (var node in nodes.EnumerateArray().Take(12))
            {
                if (node.ValueKind != JsonValueKind.Object) continue;
                ancestry.Add(new
                {
                    idSuffix = StringValue(node, "idSuffix", 8),
                    parentSuffix = StringValue(node, "parentSuffix", 8),
                    role = StringValue(node, "role", 40),
                    recipient = StringValue(node, "recipient", 96),
                    channel = StringValue(node, "channel", 40),
                    endTurn = BooleanValue(node, "endTurn"),
                    status = StringValue(node, "status", 80),
                    hidden = BooleanValue(node, "hidden"),
                    hasText = BooleanValue(node, "hasText"),
                    contentType = StringValue(node, "contentType", 80)
                });
            }
        }

        return new
        {
            messageCount = IntegerValue(terminal, "messageCount"),
            currentNodeSuffix = StringValue(terminal, "currentNodeSuffix", 8),
            currentNodePresent = BooleanValue(terminal, "currentNodePresent"),
            ancestry
        };
    }

    private static object SafeIncidentTransition(JsonElement transition)
    {
        return new
        {
            sequence = IntegerValue(transition, "sequence"),
            stage = StringValue(transition, "stage", 64),
            observedAt = IntegerValue(transition, "observedAt"),
            originObservedAt = IntegerValue(transition, "originObservedAt"),
            workerReceivedAt = IntegerValue(transition, "workerReceivedAt"),
            elapsedMs = IntegerValue(transition, "elapsedMs"),
            snapshotAgeMs = IntegerValue(transition, "snapshotAgeMs"),
            contextAgeMs = IntegerValue(transition, "contextAgeMs"),
            reason = StringValue(transition, "reason", 64),
            transport = StringValue(transition, "transport", 16),
            streamNonceSuffix = StringValue(transition, "streamNonceSuffix", 8),
            mappingConfidence = StringValue(transition, "mappingConfidence", 48),
            httpStatus = IntegerValue(transition, "httpStatus"),
            mediaTypeClass = StringValue(transition, "mediaTypeClass", 24),
            protocolShape = StringValue(transition, "protocolShape", 24),
            byteCount = IntegerValue(transition, "byteCount"),
            chunkCount = IntegerValue(transition, "chunkCount"),
            frameCount = IntegerValue(transition, "frameCount"),
            dataFrameCount = IntegerValue(transition, "dataFrameCount"),
            jsonFrameCount = IntegerValue(transition, "jsonFrameCount"),
            doneFrameCount = IntegerValue(transition, "doneFrameCount"),
            oversizedFrameCount = IntegerValue(transition, "oversizedFrameCount"),
            rawTokenCount = IntegerValue(transition, "rawTokenCount"),
            decodedCandidateCount = IntegerValue(transition, "decodedCandidateCount"),
            responseStartMs = IntegerValue(transition, "responseStartMs"),
            firstByteMs = IntegerValue(transition, "firstByteMs"),
            eofMs = IntegerValue(transition, "eofMs"),
            semanticFinalEligible = BooleanValue(transition, "semanticFinalEligible"),
            semanticRejectionReason = StringValue(transition, "semanticRejectionReason", 48),
            visibility = StringValue(transition, "visibility", 16),
            pageHasFocus = BooleanValue(transition, "pageHasFocus"),
            pageFrozen = BooleanValue(transition, "pageFrozen"),
            tabActive = BooleanValue(transition, "tabActive"),
            tabFrozen = BooleanValue(transition, "tabFrozen"),
            tabDiscarded = BooleanValue(transition, "tabDiscarded"),
            windowFocused = BooleanValue(transition, "windowFocused"),
            windowState = StringValue(transition, "windowState", 16),
            count = IntegerValue(transition, "count")
        };
    }

    private static object? HiddenWindowIncident(JsonElement root)
    {
        if (!root.TryGetProperty("incident", out var incident) || incident.ValueKind != JsonValueKind.Object) return null;
        var transitions = new List<object>();
        if (incident.TryGetProperty("transitions", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
        {
            foreach (var transition in nodes.EnumerateArray().TakeLast(48))
            {
                if (transition.ValueKind == JsonValueKind.Object) transitions.Add(SafeIncidentTransition(transition));
            }
        }

        return new
        {
            schemaVersion = IntegerValue(incident, "schemaVersion"),
            incidentId = StringValue(incident, "incidentId", 80),
            kind = StringValue(incident, "kind", 32),
            workerInstanceSuffix = StringValue(incident, "workerInstanceSuffix", 8),
            tabId = IntegerValue(incident, "tabId"),
            chromeDocumentSuffix = StringValue(incident, "chromeDocumentSuffix", 8),
            requestSuffix = StringValue(incident, "requestSuffix", 8),
            startedAt = IntegerValue(incident, "startedAt"),
            settledAt = IntegerValue(incident, "settledAt"),
            streamFinalAt = IntegerValue(incident, "streamFinalAt"),
            routeClass = StringValue(incident, "routeClass", 24),
            httpStatus = IntegerValue(incident, "httpStatus"),
            requestOutcome = StringValue(incident, "requestOutcome", 24),
            captureResult = StringValue(incident, "captureResult", 48),
            mappingConfidence = StringValue(incident, "mappingConfidence", 48),
            mappingCandidateCount = IntegerValue(incident, "mappingCandidateCount"),
            traceState = StringValue(incident, "traceState", 32),
            firstUnresolvedBoundary = StringValue(incident, "firstUnresolvedBoundary", 64),
            droppedTransitions = IntegerValue(incident, "droppedTransitions"),
            coalescedTransitions = IntegerValue(incident, "coalescedTransitions"),
            retentionEvictedIncidents = IntegerValue(incident, "retentionEvictedIncidents"),
            transitions
        };
    }

    public static JsonElement Event(JsonElement input)
    {
        var safe = new
        {
            source = StringValue(input, "source", 40),
            status = StringValue(input, "status", 96),
            observedAt = StringValue(input, "observedAt", 64),
            extensionVersion = StringValue(input, "extensionVersion", 32),
            correlationId = StringValue(input, "correlationId", 80),
            sourceCommitSuffix = StringValue(input, "sourceCommitSuffix", 8),
            tabId = IntegerValue(input, "tabId"),
            statusCode = IntegerValue(input, "statusCode"),
            attempt = IntegerValue(input, "attempt"),
            elapsedMs = IntegerValue(input, "elapsedMs"),
            queuedMessages = IntegerValue(input, "queuedMessages"),
            watchCount = IntegerValue(input, "watchCount"),
            requestContextCount = IntegerValue(input, "requestContextCount"),
            eventSequence = IntegerValue(input, "eventSequence"),
            frozen = BooleanValue(input, "frozen"),
            discarded = BooleanValue(input, "discarded"),
            deliveredNow = BooleanValue(input, "deliveredNow"),
            presented = BooleanValue(input, "presented"),
            triggerPath = StringValue(input, "triggerPath", 160),
            reason = StringValue(input, "reason", 160),
            captureSource = StringValue(input, "captureSource", 160),
            presentationState = StringValue(input, "presentationState", 48),
            error = StringValue(input, "error", 240),
            conversationSuffix = StringValue(input, "conversationSuffix", 8),
            notificationSuffix = StringValue(input, "notificationSuffix", 8),
            chromeDocumentSuffix = StringValue(input, "chromeDocumentSuffix", 8),
            requestSuffix = StringValue(input, "requestSuffix", 8),
            promptSuffix = StringValue(input, "promptSuffix", 8),
            assistantSuffix = StringValue(input, "assistantSuffix", 8),
            revisionSuffix = StringValue(input, "revisionSuffix", 8),
            claimSource = StringValue(input, "claimSource", 64),
            workerInstanceSuffix = StringValue(input, "workerInstanceSuffix", 8),
            statusRuntimeSuffix = StringValue(input, "statusRuntimeSuffix", 8),
            monitorRuntimeSuffix = StringValue(input, "monitorRuntimeSuffix", 8),
            workStatusContractId = StringValue(input, "workStatusContractId", 64),
            workStatusContractSemanticSha256 = StringValue(input, "workStatusContractSemanticSha256", 64),
            workStatusCompatibility = StringValue(input, "workStatusCompatibility", 320),
            incident = HiddenWindowIncident(input),
            terminalState = TerminalState(input)
        };
        return JsonSerializer.SerializeToElement(safe, JsonOptions.Default);
    }

    private static object SafeTab(JsonElement tab) => new
    {
        tabId = IntegerValue(tab, "tabId"),
        active = BooleanValue(tab, "active"),
        frozen = BooleanValue(tab, "frozen"),
        discarded = BooleanValue(tab, "discarded"),
        hasConversation = BooleanValue(tab, "hasConversation"),
        conversationSuffix = StringValue(tab, "conversationSuffix", 8),
        contentScriptLive = BooleanValue(tab, "contentScriptLive")
    };

    private static object SafeConversation(JsonElement conversation) => new
    {
        conversationSuffix = StringValue(conversation, "conversationSuffix", 8),
        apiSource = StringValue(conversation, "apiSource", 80),
        apiStatus = IntegerValue(conversation, "apiStatus"),
        apiOk = BooleanValue(conversation, "apiOk"),
        terminalCapturePresent = BooleanValue(conversation, "terminalCapturePresent"),
        terminalCaptureAgeMs = IntegerValue(conversation, "terminalCaptureAgeMs"),
        error = StringValue(conversation, "error", 240),
        terminalState = TerminalState(conversation)
    };

    public static JsonElement Probe(JsonElement input)
    {
        var tabs = new List<object>();
        if (input.TryGetProperty("tabs", out var tabArray) && tabArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var tab in tabArray.EnumerateArray().Take(30))
                if (tab.ValueKind == JsonValueKind.Object) tabs.Add(SafeTab(tab));
        }

        var conversations = new List<object>();
        if (input.TryGetProperty("conversations", out var conversationArray) && conversationArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var conversation in conversationArray.EnumerateArray().Take(8))
                if (conversation.ValueKind == JsonValueKind.Object) conversations.Add(SafeConversation(conversation));
        }

        var safe = new
        {
            extensionVersion = StringValue(input, "extensionVersion", 32),
            observedAt = StringValue(input, "observedAt", 64),
            bridgeState = IntegerValue(input, "bridgeState"),
            queuedNativeMessages = IntegerValue(input, "queuedNativeMessages"),
            tabCount = IntegerValue(input, "tabCount"),
            requestContextCount = IntegerValue(input, "requestContextCount"),
            watchCount = IntegerValue(input, "watchCount"),
            authSessionAvailable = BooleanValue(input, "authSessionAvailable"),
            error = StringValue(input, "error", 240),
            tabs,
            conversations
        };
        return JsonSerializer.SerializeToElement(safe, JsonOptions.Default);
    }
}
