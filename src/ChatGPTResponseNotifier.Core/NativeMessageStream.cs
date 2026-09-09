using System.Buffers.Binary;
using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed class NativeMessageStream
{
    private readonly Stream _input;
    private readonly Stream _output;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public NativeMessageStream(Stream input, Stream output)
    {
        _input = input;
        _output = output;
    }

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken = default)
    {
        var header = new byte[4];
        var headerRead = await ReadExactOrEofAsync(_input, header, cancellationToken).ConfigureAwait(false);
        if (!headerRead) return null;

        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > NativeHostConstants.MaxMessageBytes)
        {
            throw new InvalidDataException($"Native message length {length} is outside the accepted range.");
        }

        var payload = new byte[length];
        if (!await ReadExactOrEofAsync(_input, payload, cancellationToken).ConfigureAwait(false))
        {
            throw new EndOfStreamException("Native message ended before the declared payload length.");
        }

        return JsonDocument.Parse(payload);
    }

    public async Task WriteAsync<T>(T message, CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions.Default);
        if (payload.Length <= 0 || payload.Length > NativeHostConstants.MaxMessageBytes)
        {
            throw new InvalidDataException($"Native response length {payload.Length} is outside the accepted range.");
        }

        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);

        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await _output.WriteAsync(header, cancellationToken).ConfigureAwait(false);
            await _output.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
            await _output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static async Task<bool> ReadExactOrEofAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, buffer.Length - offset), cancellationToken).ConfigureAwait(false);
            if (read == 0) return offset == 0 ? false : throw new EndOfStreamException("Stream ended mid-frame.");
            offset += read;
        }
        return true;
    }
}
