$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$projectRoot = Split-Path $PSScriptRoot -Parent
$proxy = Join-Path $projectRoot '.venv\Scripts\litellm.exe'
if (-not (Test-Path -LiteralPath $proxy)) { throw 'Install first: python -m venv .venv; .\.venv\Scripts\python -m pip install -r requirements-proxy.txt' }
if (-not $env:LITELLM_MASTER_KEY) { throw 'Set LITELLM_MASTER_KEY and provider environment variables before starting.' }
& $proxy --config (Join-Path $projectRoot 'litellm_config.yaml') --host 127.0.0.1 --port 4000
