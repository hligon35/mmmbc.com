param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

$ErrorActionPreference = "Stop"

$dest = Join-Path $Root "cf_site"

# Ensure the output is an exact mirror of the canonical source files.
# This also removes any stale/duplicate folders (ex: cf_site/Pages/Pages) from prior builds.
if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Copy top-level public files
$files=@(
  "index.html","robots.txt","sitemap.xml",
  "style.css","theme.css","schedule_app.css","schedule_app.js","script.js",
  "announcements_ticker.js","bulletins_widget.js","facility_rental_form.js","facility_rental_nonmembers_form.js",
  "announcements.json","bulletins.json","documents.json","gallery.json","livestream.json","schedule.json","site-settings.json"
)
foreach($f in $files){
  $src=Join-Path $Root $f
  if(Test-Path $src){ Copy-Item -Force $src (Join-Path $dest $f) }
}

# Copy required directories
$dirs=@("Pages","Icons","ConImg","bulletins","rental")
foreach($d in $dirs){
  $src=Join-Path $Root $d
  if(Test-Path $src){
    Copy-Item -Recurse -Force $src (Join-Path $dest $d)
  }
}

# Copy admin UI (static only) under /admin/
$adminUi = Join-Path $Root "admin\public"
if(Test-Path $adminUi){
  $adminDest = Join-Path $dest "admin"
  New-Item -ItemType Directory -Force -Path $adminDest | Out-Null
  Copy-Item -Recurse -Force (Join-Path $adminUi "*") $adminDest

  # Remove custom login pages from the deployed static admin.
  $remove=@("login.html","login.js","login_legacy.html")
  foreach($f in $remove){
    $p = Join-Path $adminDest $f
    if(Test-Path $p){ Remove-Item -Force $p }
  }

  # Make the gallery layout part of the generated assets instead of relying
  # on Worker HTML injection or browser-side DOM movement.
  $adminIndex = Join-Path $adminDest "index.html"
  $adminCss = Join-Path $adminDest "admin.css"

  if(Test-Path $adminIndex){
    $html = Get-Content -Raw -Path $adminIndex

    $bulkPattern = '(?s)\s*<div class="photoBulkBar" id="photoBulkBar" hidden>.*?</div>'
    $bulkMatch = [regex]::Match($html, $bulkPattern)
    if($bulkMatch.Success){
      $bulkHtml = $bulkMatch.Value.Trim()
      $bulkHtml = $bulkHtml.Replace('class="photoBulkBar"', 'class="photoBulkBar photoBulkBar--header"')
      $html = [regex]::Replace($html, $bulkPattern, '', 1)

      $headerMarker = '<div class="syncProgress" id="syncProgressWrap" aria-live="polite" hidden>'
      if($html.Contains($headerMarker)){
        $html = $html.Replace($headerMarker, "$bulkHtml`r`n            $headerMarker")
      }
    }

    Set-Content -Path $adminIndex -Value $html -Encoding UTF8
  }

  if(Test-Path $adminCss){
    $galleryCss = @'

/* Build-enforced admin gallery layout */
#photoPager:not([hidden]),
#photoPagerBottom:not([hidden]) {
  display: flex !important;
  width: fit-content !important;
  max-width: 100%;
  margin-left: auto !important;
  margin-right: auto !important;
  justify-content: center !important;
  align-items: center !important;
  gap: 14px !important;
}

#photoPager:not([hidden]) {
  margin-top: 26px !important;
  margin-bottom: 22px !important;
}

#photoPagerBottom:not([hidden]) {
  margin-top: 24px !important;
  margin-bottom: 10px !important;
}

#tab-photos > .sectionHeader {
  align-items: flex-start;
}

#tab-photos > .sectionHeader > .iconGroup {
  margin-left: auto;
  align-items: flex-end;
  min-width: min(100%, 620px);
}

#tab-photos .photoBulkBar--header {
  position: static !important;
  inset: auto !important;
  width: auto !important;
  max-width: 100%;
  margin: 8px 0 0 auto !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

#tab-photos .photoBulkBar--header[hidden] {
  display: none !important;
}

#tab-photos .photoBulkBar--header #photoBulkCount {
  width: 100%;
  text-align: right;
}

@media (max-width: 900px) {
  #tab-photos > .sectionHeader {
    flex-wrap: wrap;
  }

  #tab-photos > .sectionHeader > .iconGroup {
    width: 100%;
    min-width: 0;
    align-items: stretch;
  }

  #tab-photos .photoBulkBar--header {
    margin-left: 0 !important;
    justify-content: flex-start;
  }

  #tab-photos .photoBulkBar--header #photoBulkCount {
    text-align: left;
  }
}
'@
    Add-Content -Path $adminCss -Value $galleryCss -Encoding UTF8
  }
}

# Never publish server code or data
$maybeAdminServer = Join-Path $dest "admin\server.js"
if(Test-Path $maybeAdminServer){ Remove-Item -Force $maybeAdminServer }
$maybeAdminData = Join-Path $dest "admin\data"
if(Test-Path $maybeAdminData){ Remove-Item -Recurse -Force $maybeAdminData }

Write-Host "Built cf_site at: $dest"
