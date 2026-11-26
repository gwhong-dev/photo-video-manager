# 파일 위치: .github/scripts/install-tools.ps1
# 역할: CI(GitHub Windows PC)에 외부 도구(exiftool, FFmpeg, ImageMagick)를 준비하고 PATH 에 알려 줘요
#   check.yml(점검) 과 electron-cache.yml(main 에 캐시 채우기) 이 같이 써요
#
# 왜 이렇게: 전에는 Chocolatey 로 받았는데, 그 서버가 503(잠깐 고장)을 내면 받기가 조용히 실패하고
#   점검이 "exiftool을 찾지 못해서" 로 통째로 실패했어요 (2026-11-24 CI 20번 중 7번, #148 등)
#   → 공식 배포 파일을 버전을 정해 직접 받아요
#      exiftool: SourceForge (exiftool.org 는 최신판만 두고 옛 버전은 SourceForge 로 옮겨서, 버전을 정해 두려면 여기가 맞아요)
#      FFmpeg:   GyanD/codexffmpeg GitHub 릴리스 (gyan.dev 의 Windows 빌드를 GitHub 에 올려 둔 곳)
#   받은 파일은 $ToolsDir 에 두고 actions/cache 로 저장해서, 다음부터는 받지 않고 꺼내 써요
#   직접 받기가 3번씩 실패하면 마지막으로 Chocolatey 를 한 번 시도해요
#   ImageMagick 은 GitHub Windows PC 에 이미 깔려 있어요 (없을 때만 Chocolatey)
#
# 버전 올리기: check.yml 과 electron-cache.yml 의 EXIFTOOL_VERSION · FFMPEG_VERSION 과
#   EXIFTOOL_SHA256 · FFMPEG_SHA256 네 값을 두 파일에서 같이 바꿔요
#   (캐시 열쇠에 버전이 들어 있어서 바뀌면 새로 받아요)
#   SHA256 = 파일 지문. 받은 파일이 정해 둔 파일과 한 글자라도 다르면 쓰지 않아요 (바꿔치기 · 깨진 파일 막기)
#   새 값 구하기: 파일을 받아 PowerShell 에서 (Get-FileHash 파일.zip).Hash
# 폴더 모양(아래 $exifDir · $ffDir 안 구조)을 바꾸면 두 파일의 캐시 열쇠 앞부분 "tools-" 도 바꿔요 (옛 캐시를 안 꺼내게)

param(
  [Parameter(Mandatory = $true)][string]$ToolsDir,
  [Parameter(Mandatory = $true)][string]$ExiftoolVersion,
  [Parameter(Mandatory = $true)][string]$FfmpegVersion,
  [Parameter(Mandatory = $true)][string]$ExiftoolSha256,
  [Parameter(Mandatory = $true)][string]$FfmpegSha256
)

$ErrorActionPreference = 'Stop'
$exifDir = Join-Path $ToolsDir 'exiftool'
$ffDir = Join-Path $ToolsDir 'ffmpeg'
$exifExe = Join-Path $exifDir 'exiftool.exe'
$ffExe = Join-Path $ffDir 'bin\ffmpeg.exe'
New-Item -ItemType Directory -Force $ToolsDir | Out-Null

# 주소에서 파일 받기: 실패하면 10초 쉬고 다시, 최대 3번 (curl.exe 는 Windows 에 들어 있어요)
function Save-Url([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    & curl.exe -fsSL --connect-timeout 30 --max-time 600 -o $out $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out) -and (Get-Item $out).Length -gt 1MB) { return $true }
    Write-Host "받기 실패 ($i/3): $url"
    Start-Sleep -Seconds 10
  }
  return $false
}

# 받고 나서 지문(SHA256) 비교: 다르면 지우고 "받기 실패" 로 쳐요 → Chocolatey 로 넘어가고 캐시에 저장하지 않아요
function Save-Checked([string]$url, [string]$out, [string]$sha) {
  if (-not (Save-Url $url $out)) { return $false }
  $got = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($got -ne $sha) {
    Write-Host "❌ 지문이 달라요: $url (받은 값 $got)"
    Remove-Item -Force $out
    return $false
  }
  return $true
}

# 압축을 풀고, 안에 든 폴더 하나의 내용을 $dest 로 옮겨요 (zip 안이 "이름-버전/..." 한 겹이라서)
function Expand-One([string]$zip, [string]$dest) {
  $tmp = Join-Path $ToolsDir ('unzip-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $inner.FullName $dest
  Remove-Item -Recurse -Force $tmp
  Remove-Item -Force $zip
}

# 1) exiftool
if (Test-Path $exifExe) {
  Write-Host "exiftool: 캐시에 있음"
} else {
  $zip = Join-Path $ToolsDir 'exiftool.zip'
  $url = "https://sourceforge.net/projects/exiftool/files/exiftool-${ExiftoolVersion}_64.zip/download"
  if (Save-Checked $url $zip $ExiftoolSha256) {
    Expand-One $zip $exifDir
    # Windows 판 실행 파일 이름은 "exiftool(-k).exe" (끝나면 키 입력을 기다림) → exiftool.exe 로 바꾸면 기다리지 않아요
    Rename-Item (Join-Path $exifDir 'exiftool(-k).exe') 'exiftool.exe'
  } else {
    Write-Host '⚠️ exiftool 직접 받기 실패 → Chocolatey 로 한 번 시도'
    choco install exiftool -y --no-progress
  }
}

# 2) FFmpeg (ffprobe 도 같은 bin 폴더에 들어 있어요)
if (Test-Path $ffExe) {
  Write-Host "FFmpeg: 캐시에 있음"
} else {
  $zip = Join-Path $ToolsDir 'ffmpeg.zip'
  $url = "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/ffmpeg-$FfmpegVersion-essentials_build.zip"
  if (Save-Checked $url $zip $FfmpegSha256) {
    Expand-One $zip $ffDir
  } else {
    Write-Host '⚠️ FFmpeg 직접 받기 실패 → Chocolatey 로 한 번 시도'
    choco install ffmpeg -y --no-progress
  }
}

# 3) ImageMagick: 이미 깔려 있으면 그대로
$magick = Get-ChildItem 'C:\Program Files\ImageMagick*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $magick) {
  Write-Host 'ImageMagick 이 없어서 Chocolatey 로 설치'
  choco install imagemagick -y --no-progress
  $magick = Get-ChildItem 'C:\Program Files\ImageMagick*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
}

# 다음 단계부터 이름만으로 찾을 수 있게 PATH 에 알려 줘요 (점검의 lib/tools.js 는 PATH 에서도 찾아요)
$paths = @()
if (Test-Path $exifExe) { $paths += $exifDir }
if (Test-Path $ffExe) { $paths += (Join-Path $ffDir 'bin') }
if ($magick) { $paths += $magick.FullName }
if ($env:GITHUB_PATH) { $paths | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append }

# 캐시에 저장해도 되는지: 직접 받은 exiftool · FFmpeg 가 둘 다 있을 때만 (Chocolatey 로 대신 깐 경우는 저장하지 않아요)
$complete = (Test-Path $exifExe) -and (Test-Path $ffExe)
if ($env:GITHUB_OUTPUT) { "complete=$($complete.ToString().ToLower())" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append }

# 확인: 셋 다 실행되는지. 하나라도 안 되면 여기서 실패시켜 "점검 실패" 와 구별되게 해요
$exifCmd = if (Test-Path $exifExe) { $exifExe } else { 'exiftool' }
$ffCmd = if (Test-Path $ffExe) { $ffExe } else { 'ffmpeg' }
$magickCmd = if ($magick) { Join-Path $magick.FullName 'magick.exe' } else { 'magick' }
$ok = $true
foreach ($t in @(@('exiftool', $exifCmd, '-ver'), @('FFmpeg', $ffCmd, '-version'), @('ImageMagick', $magickCmd, '-version'))) {
  try {
    # 끝 코드는 파이프(| Select-Object) 전에 읽어요. 파이프로 첫 줄만 받으면 도구가 중간에 끊겨 끝 코드가 -1 이 돼요
    $all = & $t[1] $t[2] 2>&1
    $code = $LASTEXITCODE
    $out = $all | Select-Object -First 1
    if ($code -ne 0) { throw "끝 코드 $code" }
    Write-Host "$($t[0]): $out"
  } catch {
    Write-Host "❌ $($t[0]) 실행 안 됨: $_"
    $ok = $false
  }
}
if (-not $ok) { exit 1 }
exit 0
