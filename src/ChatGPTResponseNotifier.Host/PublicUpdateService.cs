using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed record UpdateStatusSnapshot(
    string State,
    string CurrentVersion,
    string? AvailableVersion = null,
    string? Error = null,
    DateTimeOffset? CheckedAt = null);

internal sealed record UpdateCheckResult(UpdateStatusSnapshot Status, InstalledBundle? InstalledBundle = null);

internal sealed class PublicUpdateService : IDisposable
{
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Func<UpdateStatusSnapshot, Task> _statusChanged;
    private UpdateStatusSnapshot _status;

    public PublicUpdateService(Func<UpdateStatusSnapshot, Task> statusChanged)
    {
        _statusChanged = statusChanged;
        _http = new HttpClient
        {
            Timeout = TimeSpan.FromMinutes(5)
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("ChatGPTResponseNotifier", "1.0"));
        var current = BundleInstaller.ReadInstalledExtensionVersion() ?? "0.0.0";
        _status = new UpdateStatusSnapshot("waiting", current);
    }

    public UpdateStatusSnapshot Status => _status;

    public async Task<UpdateCheckResult> CheckAndInstallAsync(CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return new UpdateCheckResult(_status);
        }

        string? archivePath = null;
        try
        {
            var currentVersion = BundleInstaller.ReadInstalledExtensionVersion() ?? _status.CurrentVersion;
            await SetStatusAsync(new UpdateStatusSnapshot("checking", currentVersion)).ConfigureAwait(false);

            using var manifestResponse = await _http.GetAsync(PublicUpdateFeed.ManifestUrl, HttpCompletionOption.ResponseContentRead, cancellationToken).ConfigureAwait(false);
            manifestResponse.EnsureSuccessStatusCode();
            var manifestJson = await manifestResponse.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var manifest = PublicUpdateFeed.Parse(manifestJson);

            if (PublicUpdateFeed.CompareVersions(manifest.Version, currentVersion) <= 0)
            {
                var current = new UpdateStatusSnapshot("current", currentVersion, manifest.Version, null, DateTimeOffset.UtcNow);
                await SetStatusAsync(current).ConfigureAwait(false);
                return new UpdateCheckResult(current);
            }

            await SetStatusAsync(new UpdateStatusSnapshot("downloading", currentVersion, manifest.Version)).ConfigureAwait(false);
            var updateRoot = Path.Combine(NativeHostInstaller.DataRoot, "updates");
            Directory.CreateDirectory(updateRoot);
            archivePath = Path.Combine(updateRoot, $"ChatGPT-Response-Notifier-{manifest.Version}-{Guid.NewGuid():N}.zip");

            using (var response = await _http.GetAsync(manifest.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                await using var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                await using var destination = new FileStream(archivePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, useAsync: true);
                await source.CopyToAsync(destination, cancellationToken).ConfigureAwait(false);
            }

            await SetStatusAsync(new UpdateStatusSnapshot("installing", currentVersion, manifest.Version)).ConfigureAwait(false);
            var installed = await Task.Run(
                () => BundleInstaller.InstallArchive(new UpdateInstallRequest(
                    manifest.Version,
                    manifest.SourceCommit,
                    archivePath,
                    manifest.Sha256)),
                cancellationToken).ConfigureAwait(false);

            var finished = new UpdateStatusSnapshot("installed", installed.Version, installed.Version, null, DateTimeOffset.UtcNow);
            await SetStatusAsync(finished).ConfigureAwait(false);
            return new UpdateCheckResult(finished, installed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            var currentVersion = BundleInstaller.ReadInstalledExtensionVersion() ?? _status.CurrentVersion;
            var failed = new UpdateStatusSnapshot("error", currentVersion, _status.AvailableVersion, error.Message, DateTimeOffset.UtcNow);
            FileLog.Write("Public managed update check failed", error);
            await SetStatusAsync(failed).ConfigureAwait(false);
            return new UpdateCheckResult(failed);
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(archivePath))
            {
                try { File.Delete(archivePath); } catch { }
            }
            _gate.Release();
        }
    }

    private async Task SetStatusAsync(UpdateStatusSnapshot status)
    {
        _status = status;
        try { await _statusChanged(status).ConfigureAwait(false); } catch { }
    }

    public void Dispose()
    {
        _http.Dispose();
        _gate.Dispose();
    }
}
