/**
 * Native Windows TTS synthesizer for Antigravity Sidecar
 * Uses System.Speech.Synthesis on Windows for zero-latency, 100% offline speech synthesis.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cachedVoices = null;

/**
 * Lists installed Windows System.Speech voices (cached after first lookup).
 * @returns {Promise<Array<{name: string, lang: string, gender: string}>>}
 */
export async function getInstalledVoices() {
  if (cachedVoices) return cachedVoices;

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object {
  @{
    name = $_.VoiceInfo.Name
    lang = $_.VoiceInfo.Culture.Name
    gender = $_.VoiceInfo.Gender.ToString()
  }
}
$synth.Dispose()
ConvertTo-Json -InputObject @($voices) -Compress
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 6000 },
      (err, stdout) => {
        if (err || !stdout) {
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          cachedVoices = Array.isArray(parsed) ? parsed : [parsed];
          resolve(cachedVoices);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/**
 * Synthesizes text to a WAV audio buffer.
 * @param {string} text
 * @param {object} options
 * @returns {Promise<Buffer>}
 */
export async function synthesizeWav(text, options = {}) {
  const safeText = String(text || '').trim();
  if (!safeText) return Buffer.alloc(0);

  const id = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const wavPath = join(tmpdir(), `${id}.wav`);
  const ps1Path = join(tmpdir(), `${id}.ps1`);

  const escapedText = safeText.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
  const escapedVoice = String(options.voice || '').trim().replace(/'/g, "''");
  const rateVal = options.rate ? Math.max(-10, Math.min(10, Math.round((options.rate - 1.0) * 5))) : 0;

  const selectVoiceLine = escapedVoice
    ? `try { $synth.SelectVoice('${escapedVoice}') } catch {}`
    : '';

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${selectVoiceLine}
$synth.Rate = ${rateVal}
$synth.SetOutputToWaveFile('${wavPath.replace(/\\/g, '/')}')
$synth.Speak('${escapedText}')
$synth.Dispose()
`;

  writeFileSync(ps1Path, script, 'utf8');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      { timeout: 8000 },
      (err) => {
        try {
          if (existsSync(ps1Path)) unlinkSync(ps1Path);
        } catch {}

        if (err) {
          try {
            if (existsSync(wavPath)) unlinkSync(wavPath);
          } catch {}
          return reject(err);
        }

        try {
          if (existsSync(wavPath)) {
            const buf = readFileSync(wavPath);
            unlinkSync(wavPath);
            return resolve(buf);
          }
          reject(new Error('WAV output file was not generated'));
        } catch (readErr) {
          reject(readErr);
        }
      }
    );
  });
}

/**
 * Directly speaks text on the host system audio device.
 * @param {string} text
 * @param {object} options
 */
export function speakDirect(text, options = {}) {
  const safeText = String(text || '').trim();
  if (!safeText) return;

  const id = `speak-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ps1Path = join(tmpdir(), `${id}.ps1`);
  const escapedText = safeText.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
  const escapedVoice = String(options.voice || '').trim().replace(/'/g, "''");
  const rateVal = options.rate ? Math.max(-10, Math.min(10, Math.round((options.rate - 1.0) * 5))) : 0;

  const selectVoiceLine = escapedVoice
    ? `try { $synth.SelectVoice('${escapedVoice}') } catch {}`
    : '';

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${selectVoiceLine}
$synth.Rate = ${rateVal}
$synth.Speak('${escapedText}')
$synth.Dispose()
Remove-Item -Path '${ps1Path.replace(/\\/g, '/')}' -ErrorAction SilentlyContinue
`;

  writeFileSync(ps1Path, script, 'utf8');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.unref();
}

