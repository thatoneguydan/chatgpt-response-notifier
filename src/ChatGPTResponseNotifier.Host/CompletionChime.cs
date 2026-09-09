using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace ChatGPTResponseNotifier.Host;

internal static class CompletionChime
{
    private const int SampleRate = 44_100;
    private const double AttackSeconds = 0.015;
    private const double FloorGain = 0.0001;
    private const uint SndAsync = 0x0001;
    private const uint SndMemory = 0x0004;
    private const uint SndNodefault = 0x0002;

    // Matches the original extension's WebAudio chime:
    // 740 Hz for 160 ms, followed by 988 Hz for 220 ms.
    private static readonly byte[] Wave = BuildWave();

    public static void Play()
    {
        try
        {
            _ = PlaySound(Wave, IntPtr.Zero, SndAsync | SndMemory | SndNodefault);
        }
        catch
        {
            // Sound must never interfere with toast delivery.
        }
    }

    internal static byte[] BuildWave()
    {
        const double leadSeconds = 0.020;
        const double firstStart = leadSeconds;
        const double firstDuration = 0.160;
        const double secondStart = leadSeconds + 0.180;
        const double secondDuration = 0.220;
        var totalSeconds = secondStart + secondDuration + 0.020;
        var sampleCount = (int)Math.Ceiling(totalSeconds * SampleRate);
        var pcm = new short[sampleCount];

        AddTone(pcm, 740.0, firstStart, firstDuration, 0.18);
        AddTone(pcm, 988.0, secondStart, secondDuration, 0.20);

        const int headerBytes = 44;
        var wave = new byte[headerBytes + pcm.Length * sizeof(short)];
        var span = wave.AsSpan();
        "RIFF"u8.CopyTo(span[0..4]);
        BinaryPrimitives.WriteInt32LittleEndian(span[4..8], wave.Length - 8);
        "WAVE"u8.CopyTo(span[8..12]);
        "fmt "u8.CopyTo(span[12..16]);
        BinaryPrimitives.WriteInt32LittleEndian(span[16..20], 16);
        BinaryPrimitives.WriteInt16LittleEndian(span[20..22], 1);
        BinaryPrimitives.WriteInt16LittleEndian(span[22..24], 1);
        BinaryPrimitives.WriteInt32LittleEndian(span[24..28], SampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(span[28..32], SampleRate * sizeof(short));
        BinaryPrimitives.WriteInt16LittleEndian(span[32..34], sizeof(short));
        BinaryPrimitives.WriteInt16LittleEndian(span[34..36], 16);
        "data"u8.CopyTo(span[36..40]);
        BinaryPrimitives.WriteInt32LittleEndian(span[40..44], pcm.Length * sizeof(short));

        for (var i = 0; i < pcm.Length; i++)
        {
            BinaryPrimitives.WriteInt16LittleEndian(span.Slice(headerBytes + i * sizeof(short), sizeof(short)), pcm[i]);
        }

        return wave;
    }

    private static void AddTone(short[] pcm, double frequency, double startSeconds, double durationSeconds, double peakGain)
    {
        var startSample = (int)Math.Round(startSeconds * SampleRate);
        var toneSamples = (int)Math.Round(durationSeconds * SampleRate);
        for (var i = 0; i < toneSamples && startSample + i < pcm.Length; i++)
        {
            var t = i / (double)SampleRate;
            var gain = Envelope(t, durationSeconds, peakGain);
            var sample = Math.Sin(2.0 * Math.PI * frequency * t) * gain;
            var mixed = pcm[startSample + i] + (int)Math.Round(sample * short.MaxValue);
            pcm[startSample + i] = (short)Math.Clamp(mixed, short.MinValue, short.MaxValue);
        }
    }

    private static double Envelope(double t, double duration, double peakGain)
    {
        if (t <= 0) return FloorGain;
        if (t < AttackSeconds)
        {
            return FloorGain * Math.Pow(peakGain / FloorGain, t / AttackSeconds);
        }

        var decayDuration = Math.Max(0.001, duration - AttackSeconds);
        var decayProgress = Math.Clamp((t - AttackSeconds) / decayDuration, 0.0, 1.0);
        return peakGain * Math.Pow(FloorGain / peakGain, decayProgress);
    }

    [DllImport("winmm.dll", SetLastError = false)]
    private static extern bool PlaySound(byte[] pszSound, IntPtr hmod, uint fdwSound);
}
