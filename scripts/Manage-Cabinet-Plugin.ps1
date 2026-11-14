param(
  [ValidateSet('Status', 'Install', 'Publish', 'Rollback', 'Uninstall')]
  [string]$Action = 'Install',
  [string]$Version = '',
  [string]$Added = '',
  [string]$Changed = '',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptRoot
$PatchScript = Join-Path $ScriptRoot 'patch-host.cjs'
$PkgJsonPath = Join-Path $RepoRoot 'package.json'
$ChangelogPath = Join-Path $RepoRoot 'CHANGELOG.md'

function Stop-RunningDsh {
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($procs) {
    Stop-Process -Name 'DeepSeek Harness' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
  }
}

function Start-FormalDsh {
  $candidates = @(
    ( & { if ($env:DSH_APP_DIR) { Join-Path $env:DSH_APP_DIR 'DeepSeek Harness.exe' } } ),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($candidates.Count -gt 0) {
    Start-Process -FilePath $candidates[0]
  }
}

Push-Location $RepoRoot
try {
  switch ($Action) {
    'Status' {
      git status -sb
      git tag -l
    }
    'Install' {
      Stop-RunningDsh
      node $PatchScript --install
      Start-FormalDsh
    }
    'Publish' {
      if ($Version) {
        $cleanVer = $Version.TrimStart('v')
        $pkg = Get-Content -LiteralPath $PkgJsonPath -Raw | ConvertFrom-Json
        $pkg.version = $cleanVer
        ($pkg | ConvertTo-Json -Depth 10) + "`n" | Set-Content -LiteralPath $PkgJsonPath -Encoding UTF8
        $clientJs = Get-Content -LiteralPath (Join-Path $RepoRoot 'lib\client.js') -Raw
        $clientJs = $clientJs -replace 'var VERSION = "[^"]+";', "var VERSION = `"$cleanVer`";"
        $clientJs | Set-Content -LiteralPath (Join-Path $RepoRoot 'lib\client.js') -Encoding UTF8
      }
      $curVer = (Get-Content -LiteralPath $PkgJsonPath -Raw | ConvertFrom-Json).version
      $tag = "v$curVer"
      $dateStr = (Get-Date).ToString('yyyy-MM-dd')

      if ($Added -or $Changed) {
        $entryLines = @("## $tag ($dateStr)", "")
        if ($Added) {
          $entryLines += "### 新增内容 (Added)"
          foreach ($line in ($Added -split ';\s*|\r?\n' | Where-Object { $_.Trim() })) {
            $entryLines += "- $($line.Trim())"
          }
          $entryLines += ""
        }
        if ($Changed) {
          $entryLines += "### 修改内容 (Changed)"
          foreach ($line in ($Changed -split ';\s*|\r?\n' | Where-Object { $_.Trim() })) {
            $entryLines += "- $($line.Trim())"
          }
          $entryLines += ""
        }
        $existingCl = if (Test-Path -LiteralPath $ChangelogPath) { Get-Content -LiteralPath $ChangelogPath -Raw } else { "# Changelog`n`n---`n" }
        $updatedCl = $existingCl -replace '(---\r?\n)', "`$1`n$(($entryLines -join "`n"))"
        $updatedCl | Set-Content -LiteralPath $ChangelogPath -Encoding UTF8
      }

      $commitMsg = if ($Message) { "$Message ($tag)" } elseif ($Added -or $Changed) { "release($tag): $Added $Changed".Trim() } else { "release: $tag" }
      git add -A
      git commit -m $commitMsg
      git tag -f $tag
      $remotes = git remote
      if ($remotes -contains 'origin') {
        git push -u origin main --tags
      }
      Stop-RunningDsh
      node $PatchScript --install
      Start-FormalDsh
    }
    'Rollback' {
      if (-not $Version) {
        throw '请指定要回滚的目标版本标签，例如：-Version v0.1.0'
      }
      $targetTag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
      git checkout $targetTag
      Stop-RunningDsh
      node $PatchScript --install
      Start-FormalDsh
    }
    'Uninstall' {
      Stop-RunningDsh
      node $PatchScript --uninstall
      Start-FormalDsh
    }
  }
} finally {
  Pop-Location
}

explorer.exe /select,"$PkgJsonPath"

