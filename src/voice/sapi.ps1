<#
Synthesize one line of dialogue with Windows SAPI, capturing viseme events.

SAPI reports a viseme id and an audio timestamp for every mouth position it
passes through, which is real phoneme-level timing rather than an estimate —
the same thing Rhubarb extracts from a recording, except we get it free at
synthesis time with nothing to install.

Text arrives via a file rather than an argument so that apostrophes, quotes and
line breaks in dialogue can never break argument escaping.

Output is TSV on stdout: a "duration" header line, then one "ms<TAB>viseme"
line per event. TSV rather than JSON because ConvertTo-Json in PowerShell 5.1
silently emits an object instead of an array when given a single element.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$WavFile,
  [string]$Voice = '',
  [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

if ($Voice -ne '') {
  $available = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  $match = $available | Where-Object { $_ -like "*$Voice*" } | Select-Object -First 1
  if ($match) { $synth.SelectVoice($match) }
  else { Write-Error "voice '$Voice' not found. Installed: $($available -join ', ')" }
}
$synth.Rate = $Rate

$script:events = New-Object System.Collections.ArrayList
$synth.add_VisemeReached({
  param($sender, $e)
  # Double quotes: PowerShell only honours backtick escapes in expandable strings.
  [void]$script:events.Add(("{0}`t{1}" -f [int]$e.AudioPosition.TotalMilliseconds, [int]$e.Viseme))
})

$synth.SetOutputToWaveFile($WavFile)
$synth.Speak($text)
$synth.SetOutputToDefaultAudioDevice()
$synth.Dispose()

# Duration comes from the WAV itself rather than the last viseme, which lands
# before the final phoneme has finished sounding.
$bytes = [System.IO.File]::ReadAllBytes($WavFile)
$byteRate = [BitConverter]::ToUInt32($bytes, 28)
$dataLen = $bytes.Length - 44
$durationMs = [int](($dataLen / $byteRate) * 1000)

Write-Output ("duration`t{0}" -f $durationMs)
foreach ($line in $script:events) { Write-Output $line }
