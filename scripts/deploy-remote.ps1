[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [Alias("Host")]
  [ValidateNotNullOrEmpty()]
  [string]$RemoteHost,

  [Parameter(Mandatory)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$KeyPath,

  [string]$RemoteRoot = "/opt/mcai-src"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($RemoteRoot -ne "/opt/mcai-src") {
  throw "RemoteRoot must remain /opt/mcai-src for this deployment script."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $status = & git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Git status failed." }
  if ($status) { throw "Commit or stash local changes before deployment so all environments use the same revision." }

  $commit = (& git rev-parse --verify HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw "No commit is available to deploy." }

  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { throw "Local typecheck failed." }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw "Local tests failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Local build failed." }
  & npm run check --prefix local-cloud
  if ($LASTEXITCODE -ne 0) { throw "Local model cloud syntax check failed." }
  & npm run test --prefix local-cloud
  if ($LASTEXITCODE -ne 0) { throw "Local model cloud tests failed." }

  $archive = Join-Path ([System.IO.Path]::GetTempPath()) "mcai-$commit.tar.gz"
  try {
    & git archive --format=tar.gz --output=$archive $commit
    if ($LASTEXITCODE -ne 0) { throw "Could not create the deployment archive." }

    $remoteArchive = "/tmp/mcai-$commit.tar.gz"
    & scp -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=yes $archive "root@$RemoteHost`:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload the deployment archive." }

    $remoteCommand = @"
set -euo pipefail
export PATH=/opt/node-v22.17.0-linux-x64/bin:/opt/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
tar -xzf $remoteArchive -C $RemoteRoot
cd $RemoteRoot/apps/agent
find internal -name "*.go" -print0 | xargs -0 gofmt -w
go test ./...
go build -o /opt/mcai-agent ./cmd/mcai-agent
cd $RemoteRoot
npm run build -w @mcai/contracts
npm run test -w @mcai/cloud
npm run typecheck -w @mcai/cloud
npm run build -w @mcai/cloud
npm run build -w @mcai/web
cd $RemoteRoot/local-cloud
npm run check
npm run test
install -m 0644 $RemoteRoot/local-cloud/agent.mjs /opt/mcai-model-cloud/agent.mjs
systemctl restart mcai-agent mcai-cloud mcai-web mcai-model-cloud
systemctl is-active mcai-agent mcai-cloud mcai-web mcai-model-cloud
curl --fail --silent http://127.0.0.1:3000/ >/dev/null
"@
    & ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$RemoteHost" "bash -lc '$remoteCommand'"
    if ($LASTEXITCODE -ne 0) { throw "Remote verification or deployment failed." }
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
