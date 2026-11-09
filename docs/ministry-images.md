# Ministry profile photos

The ministry page uses the five profile-named files in `ConImg/webPages/`, seven explicitly supplied R2 keys, Earlie Fugate's existing public gallery photo, and a neutral First Aid photo placeholder.

`src/ministry-images.js` is the authoritative legacy-URL mapping and R2 alias registry. The static ministries page and both profile JSON files use the same URLs. The published-content handler maps known old WordPress image URLs at read time without changing stored text or administrator-uploaded photos.

The fixed `/cdn/gallery/site/ministry/<filename>` URLs serve only the seven registered R2 keys. They work even when an uploaded R2 object has no gallery index row. A matching gallery row marked hidden still blocks the photo; visibility lookup errors fail closed. This does not make other bucket files public or change gallery records.

At implementation time, the original gallery URLs for six supplied keys returned 404; Mary Dumas and Earlie Fugate returned image responses. The alias handler still requires the supplied object to exist in the deployed Worker's GALLERY_BUCKET. If a photo remains unavailable after deployment, verify its exact case-sensitive R2 key and its gallery visibility record.

The content loader uses `/public/site-content/<page>`, with the same published-only page whitelist as `/api/site-content/<page>`. This avoids the currently protected /api prefix while retaining authentication on editing endpoints.

The renamed Official Team photo references were updated in its static page and initial seed because those five old filenames were removed from ConImg.

First Aid currently has no supplied photo and displays `ConImg/profile-photo-pending.svg`. Replace it with a verified image when one is available.


Live follow-up: the ministry page and published-content endpoint were confirmed on the new deployment. Five named local photos, the placeholder, Earlie, and Mary loaded. Six R2 aliases returned 404. Elaine's alias now uses the verified public May 2025 `Elaine.jpeg` object. Jesse, Janice, Custodial, Discipleship Training, and Video still require live storage/visibility verification. Worker logs now distinguish `gallery_hidden`, `r2_object_missing`, and `storage_or_visibility_error`; HTTP responses remain generic. Restore missing objects in the bound bucket or deliberately update gallery visibility through the authorized admin workflow.
