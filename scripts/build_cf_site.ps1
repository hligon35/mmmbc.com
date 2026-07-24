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
  margin-top: 28px !important;
  margin-bottom: 24px !important;
}

#photoPagerBottom:not([hidden]) {
  margin-top: 26px !important;
  margin-bottom: 12px !important;
}

#tab-photos > .sectionHeader {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 340px);
  align-items: center !important;
  gap: 24px;
}

#tab-photos > .sectionHeader > .sectionHeader__left {
  min-width: 0;
}

#tab-photos > .sectionHeader > .iconGroup {
  width: 100%;
  min-width: 0;
  margin-left: 0;
  display: grid;
  justify-items: stretch;
  align-self: center;
  gap: 10px;
}

#tab-photos > .sectionHeader > .iconGroup > .iconGroup__row {
  justify-content: flex-end;
  flex-wrap: wrap;
}

#tab-photos .photoBulkBar--header {
  position: static !important;
  inset: auto !important;
  width: 100% !important;
  max-width: 100%;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

#tab-photos .photoBulkBar--header[hidden] {
  display: none !important;
}

#tab-photos .photoBulkBar--header .btn {
  width: 100%;
  min-height: 42px;
  justify-content: center;
  text-align: center;
}

#tab-photos .photoBulkBar--header #photoBulkCount {
  width: 100%;
  text-align: center;
  font-size: 0.9rem;
}

#panel-photos-manage > .muted:first-child {
  margin-bottom: 18px;
}

#photoUploadForm.form--row {
  display: grid !important;
  grid-template-columns: minmax(150px, 1fr) minmax(170px, 1fr) minmax(190px, 1.1fr) minmax(220px, 1.25fr) auto;
  align-items: end;
  gap: 14px;
  width: 100%;
  margin-bottom: 18px;
}

#photoUploadForm > .label {
  min-width: 0;
  display: grid;
  align-content: end;
  gap: 7px;
}

#photoUploadForm .input {
  width: 100%;
  min-width: 0;
  height: 54px;
}

#photoUploadForm > .btn[type="submit"] {
  height: 54px;
  min-width: 128px;
  align-self: end;
  white-space: nowrap;
}

#photoUploadHint {
  grid-column: 1 / -1;
  margin-top: -4px;
}

#photoToolbar.toolbar--nowrap {
  display: grid !important;
  grid-template-columns: repeat(4, minmax(170px, 1fr));
  align-items: end;
  gap: 14px;
  width: 100%;
  overflow: visible;
  margin-top: 0;
}

#photoToolbar > .label {
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr;
  align-content: end;
  gap: 7px;
}

#photoToolbar .input,
#photoToolbar .select {
  width: 100%;
  min-width: 0;
  height: 54px;
}

@media (max-width: 1180px) {
  #photoUploadForm.form--row {
    grid-template-columns: repeat(2, minmax(220px, 1fr));
  }

  #photoUploadForm > .btn[type="submit"] {
    width: 100%;
  }

  #photoToolbar.toolbar--nowrap {
    grid-template-columns: repeat(2, minmax(220px, 1fr));
  }
}

@media (max-width: 760px) {
  #tab-photos > .sectionHeader {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  #tab-photos > .sectionHeader > .iconGroup > .iconGroup__row {
    justify-content: flex-start;
  }

  #photoUploadForm.form--row,
  #photoToolbar.toolbar--nowrap {
    grid-template-columns: 1fr;
  }

  #photoUploadForm > .btn[type="submit"] {
    min-width: 0;
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
