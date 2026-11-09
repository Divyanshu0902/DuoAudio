/**
 * DuoAudio - Worker for Windows Audio Device Enumeration
 *
 * Runs in the native Node.js runtime to query active Windows audio playback endpoints
 * using RtAudio (WASAPI backend) from audify. Outputs clean JSON to stdout.
 */

const { RtAudio, RtAudioApi } = require('audify');

try {
  const rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const allDevices = rtAudio.getDevices();

  if (!Array.isArray(allDevices)) {
    process.stdout.write(JSON.stringify({ success: true, devices: [] }));
    process.exit(0);
  }

  // Filter playback devices (outputChannels > 0)
  const playbackDevices = allDevices
    .filter((dev) => dev && typeof dev.outputChannels === 'number' && dev.outputChannels > 0)
    .map((dev) => ({
      id: dev.id,
      name: typeof dev.name === 'string' && dev.name.trim().length > 0 ? dev.name.trim() : `Endpoint ${dev.id}`,
      outputChannels: dev.outputChannels,
      preferredSampleRate: dev.preferredSampleRate || 48000,
      isDefault: Boolean(dev.isDefaultOutput)
    }));

  process.stdout.write(JSON.stringify({ success: true, devices: playbackDevices }));
  process.exit(0);
} catch (err) {
  process.stderr.write(err.message || 'Enumeration failed');
  process.exit(1);
}
