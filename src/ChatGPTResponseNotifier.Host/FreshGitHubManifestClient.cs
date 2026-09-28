using System.Net.Http;
using System.Net.Http.Headers;

namespace ChatGPTResponseNotifier.Host;

internal static class FreshGitHubManifestClient
{
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromMinutes(1);

    public static async Task<string> GetRawAsync(
        string manifestUrl,
        string userAgentProduct,
        CancellationToken cancellationToken)
    {
        var separator = manifestUrl.Contains('?') ? '&' : '?';
        var requestUrl = $"{manifestUrl}{separator}cacheBust={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

        // Feed checks are intentionally connection-isolated. A long-lived helper
        // must not remain pinned to a stale GitHub edge/proxy after main advances.
        using var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.Zero,
            PooledConnectionIdleTimeout = TimeSpan.Zero
        };
        using var client = new HttpClient(handler)
        {
            Timeout = RequestTimeout
        };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue(userAgentProduct, "1.0"));

        using var request = new HttpRequestMessage(HttpMethod.Get, requestUrl);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.raw+json"));
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        request.Headers.CacheControl = new CacheControlHeaderValue
        {
            NoCache = true,
            NoStore = true
        };
        request.Headers.ConnectionClose = true;

        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseContentRead,
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
    }
}
