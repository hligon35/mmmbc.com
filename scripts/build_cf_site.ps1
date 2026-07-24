param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

$ErrorActionPreference = "Stop"

$dest = Join-Path $Root "cf_site"

if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

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
  $adminCss = Join-Path $adminDest "admin.css"

  if(Test-Path $adminIndex){
    $html = Get-Content -Raw -Path $adminIndex

    # Capture and remove the original bulk bar.
    $bulkPattern = '(?s)\s*<div class="photoBulkBar" id="photoBulkBar" hidden>.*?</div>'
    $bulkMatch = [regex]::Match($html, $bulkPattern)
    $bulkHtml = ''
    if($bulkMatch.Success){
      $bulkHtml = $bulkMatch.Value.Trim()
      $bulkHtml = $bulkHtml.Replace('class="photoBulkBar"', 'class="photoBulkBar photoBulkBar--pageContext"')
      $html = [regex]::Replace($html, $bulkPattern, '', 1)
    }

    # Replace the duplicate Photos section heading with one consolidated pageContext header.
    # The replacement uses the ASCII-only HTML entity &rsaquo; for the breadcrumb separator.
    $photoHeaderPattern = '(?s)<div class="pageContext" id="pageContext-photos">.*?</div>\s*<div class="sectionHeader">.*?</div>\s*<dialog class="dialog" id="photoHelpDialog"'
    $photoHeaderReplacement = @"
<div class="pageContext pageContext--photos" id="pageContext-photos">
  <div class="pageContext__main">
    <p class="pageContext__crumb"><a href="#home" class="pageContext__homeLink" data-section-target="tab-home">Home</a> &rsaquo; Photos</p>
    <h2 class="pageContext__title">Photos</h2>
    <p class="pageContext__description">Upload, organize, and refresh website photo galleries.</p>
  </div>
  <div class="pageContext__actions pageContext__actions--photos">
    <div class="pageContext__primaryActions">
      <a class="iconBtn iconBtn--help" id="photoHelpBtn" href="#photoHelpDialog" aria-label="Photo upload instructions" title="Photo upload instructions">
        <svg class="pageContextHelpIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M9.8 9a2.45 2.45 0 0 1 4.7.9c0 1.7-1.25 2.2-2.05 2.9-.5.42-.7.8-.7 1.45" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <circle cx="12" cy="17.4" r="1" fill="currentColor" />
        </svg>
      </a>
      <button class="btn" id="exportBtn" type="button">Refresh Website Gallery</button>
    </div>
    $bulkHtml
    <div class="syncProgress" id="syncProgressWrap" aria-live="polite" hidden>
      <progress class="syncProgress__meter" id="syncProgressMeter" max="500" value="0"></progress>
      <div class="syncProgress__text" id="syncProgressText">Ready.</div>
    </div>
  </div>
</div>

<dialog class="dialog" id="photoHelpDialog"
"@

    $html = [regex]::Replace($html, $photoHeaderPattern, $photoHeaderReplacement, 1)
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

.pageContext--photos {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
  gap: 28px;
  align-items: start;
}

.pageContext--photos .pageContext__main {
  min-width: 0;
}

.pageContext__actions--photos {
  display: grid;
  gap: 10px;
  justify-items: stretch;
  align-self: start;
}

.pageContext__primaryActions {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  gap: 10px;
  align-items: stretch;
}

.pageContext__primaryActions .iconBtn,
.pageContext__primaryActions .btn {
  min-height: 46px;
}

.pageContext__primaryActions .iconBtn {
  width: 46px;
  display: grid;
  place-items: center;
}

.pageContextHelpIcon {
  width: 22px;
  height: 22px;
  display: block;
}

#tab-photos > .sectionHeader {
  display: none !important;
}

#tab-photos .photoBulkBar--pageContext {
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

#tab-photos .photoBulkBar--pageContext[hidden] {
  display: none !important;
}

#tab-photos .photoBulkBar--pageContext .btn {
  width: 100%;
  min-height: 42px;
  justify-content: center;
  text-align: center;
}

#tab-photos .photoBulkBar--pageContext #photoBulkCount {
  width: 100%;
  text-align: center;
  font-size: 0.9rem;
}

#panel-photos-manage > .muted:first-child {
  margin-top: 0;
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
  grid-template-rows: 1.5rem 54px;
  align-content: end;
  gap: 7px;
  line-height: 1.2;
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
  grid-template-rows: 2.75rem 54px;
  align-content: end;
  gap: 7px;
  line-height: 1.2;
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

@media (max-width: 820px) {
  .pageContext--photos {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .pageContext__actions--photos {
    width: 100%;
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

$maybeAdminServer = Join-Path $dest "admin\server.js"
if(Test-Path $maybeAdminServer){ Remove-Item -Force $maybeAdminServer }
$maybeAdminData = Join-Path $dest "admin\data"
if(Test-Path $maybeAdminData){ Remove-Item -Recurse -Force $maybeAdminData }

Write-Host "Built cf_site at: $dest"
