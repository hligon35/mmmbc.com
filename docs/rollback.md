# Rollback

Record the active Worker version before deployment. If smoke tests fail, roll back to that version in Cloudflare and restore D1 only from the pre-deployment export when a migration changed data incompatibly. R2 changes should be versioned or copied before bulk operations.

Code rollback must be performed through a new reviewed commit. Do not rewrite shared Git history.
