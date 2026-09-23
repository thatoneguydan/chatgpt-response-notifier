using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class QuickContinueUpdateService : IDisposable
{
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private UpdateStatusSnapshot _status;

    public QuickContinueUpdateService()
    {
        _http = new HttpClient
        {
            Timeout = TimeSpan.FromMinutes(5)
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("ChatGPTQuickContinueUpdater", "1.0"));
        _status = new UpdateStatusSnapshot("waiting", QuickContinueBundleInstaller.ReadInstalledVersion() ?? "0.0.0");
    }

    public UpdateStatusSnapshot Status => _status;

    public async Task<UpdateCheckResult> CheckAndInstallAsync(CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            return new UpdateCheckResult(_status);

        string? archivePath = null;
        try
        {
            var currentVersion = QuickContinueBundleInstaller.ReadInstalledVersion();
            if (string.IsNullOrWhiteSpace(currentVersion))
            {
                _status = new UpdateStatusSnapshot("not-installed", "0.0.0", CheckedAt: DateTimeOffset.UtcNow);
                return new UpdateCheckResult(_status);
            }

            _status = new UpdateStatusSnapshot("checking", currentVersion);
            using var manifestResponse = await _http.GetAsync(QuickContinueUpdateFeed.ManifestUrl, HttpCompletionOption.ResponseContentRead, cancellationToken).ConfigureAwait(false);
            manifestResponse.EnsureSuccessStatusCode();
            var manifestJson = await manifestResponse.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var manifest = QuickContinueUpdateFeed.Parse(manifestJson);

            if (PublicUpdateFeed.CompareVersions(manifest.Version, currentVersion) <= 0)
            {
                _status = new UpdateStatusSnapshot("current", currentVersion, manifest.Version, null, DateTimeOffset.UtcNow);
                return new UpdateCheckResult(_status);
            }

            _status = new UpdateStatusSnapshot("downloading", currentVersion, manifest.Version);
            var updateRoot = Path.Combine(NativeHostInstaller.DataRoot, "quick-continue-updates");
            Directory.CreateDirectory(updateRoot);
            archivePath = Path.Combine(updateRoot, $"ChatGPT-Quick-Continue-{manifest.Version}-{Guid.NewGuid():N}.zip");

            using (var response = await _http.GetAsync(manifest.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                await using var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                await using var destination = new FileStream(archivePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, useAsync: true);
                await source.CopyToAsync(destination, cancellationToken).ConfigureAwait(false);
            }

            _status = new UpdateStatusSnapshot("installing", currentVersion, manifest.Version);
            var installedVersion = await Task.Run(
                () => QuickContinueBundleInstaller.InstallArchive(new UpdateInstallRequest(
                    manifest.Version,
                    manifest.SourceCommit,
                    archivePath,
                    manifest.Sha256)),
                cancellationToken).ConfigureAwait(false);

            _status = new UpdateStatusSnapshot("installed", installedVersion, installedVersion, null, DateTimeOffset.UtcNow);
            return new UpdateCheckResult(_status);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            var currentVersion = QuickContinueBundleInstaller.ReadInstalledVersion() ?? _status.CurrentVersion;
            _status = new UpdateStatusSnapshot("error", currentVersion, _status.AvailableVersion, error.Message, DateTimeOffset.UtcNow);
            FileLog.Write("Quick Continue managed update check failed", error);
            return new UpdateCheckResult(_status);
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

    public void Dispose()
    {
        _http.Dispose();
        _gate.Dispose();
    }
}
