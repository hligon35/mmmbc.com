param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

$ErrorActionPreference = "Stop"
$assetVersion = Get-Date -Format "yyyyMMddHHmmss"

$dest = Join-Path $Root "cf_site"

if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files=@(
  "index.html","robots.txt","sitemap.xml",
  "style.css","theme.css","schedule_app.css","home-layout-updates.css","schedule_app.js","script.js",
  "announcements_ticker.js","bulletins_widget.js","facility_rental_form.js","facility_rental_nonmembers_form.js",
  "announcements.json","bulletins.json","documents.json","gallery.json","livestream.json","schedule.json","site-settings.json"
)
foreach($f in $files){
  $src=Join-Path $Root $f
  if(Test-Path $src){ Copy-Item -Force $src (Join-Path $dest $f) }
}

$dirs=@("Pages","Icons","ConImg","bulletins","rental")
foreach($d in $dirs){
  $src=Join-Path $Root $d
  if(Test-Path $src){
    Copy-Item -Recurse -Force $src (Join-Path $dest $d)
  }
}

$adminUi = Join-Path $Root "admin\public"
if(Test-Path $adminUi){
  $adminDest = Join-Path $dest "admin"
  New-Item -ItemType Directory -Force -Path $adminDest | Out-Null
  Copy-Item -Recurse -Force (Join-Path $adminUi "*") $adminDest

  $remove=@("login.html","login.js","login_legacy.html")
  foreach($f in $remove){
    $p = Join-Path $adminDest $f
    if(Test-Path $p){ Remove-Item -Force $p }
  }

  $adminIndex = Join-Path $adminDest "index.html"
  if(Test-Path $adminIndex){
    $html = Get-Content -Raw -Path $adminIndex

    $structureCssTag = "  <link id=`"mmmbc-admin-structure-css`" rel=`"stylesheet`" href=`"/admin/admin-structure-overrides.css?v=$assetVersion`" />"
    if(-not $html.Contains('id="mmmbc-admin-structure-css"')){
      $html = $html.Replace('</head>', "$structureCssTag`r`n</head>")
    }

    $structureScriptTag = "  <script id=`"mmmbc-admin-structure-js`" src=`"/admin/admin-structure-overrides.js?v=$assetVersion`" defer></script>"
    if(-not $html.Contains('id="mmmbc-admin-structure-js"')){
      $html = $html.Replace('</body>', "$structureScriptTag`r`n</body>")
    }

    Set-Content -Path $adminIndex -Value $html -Encoding UTF8
  }
}

$maybeAdminServer = Join-Path $dest "admin\server.js"
if(Test-Path $maybeAdminServer){ Remove-Item -Force $maybeAdminServer }
$maybeAdminData = Join-Path $dest "admin\data"
if(Test-Path $maybeAdminData){ Remove-Item -Recurse -Force $maybeAdminData }

Write-Host "Built cf_site at: $dest"
