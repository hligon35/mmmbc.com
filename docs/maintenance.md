# Monthly maintenance

The scheduled workflow creates or refreshes `monthlyUpdate`, applies only in-range dependency updates, runs tests, local migrations, builds, integration checks, Wrangler dry runs, dependency auditing, and a tracked-file secret scan, then updates one pull request.

It never deploys, merges itself, sends email, runs payments, or applies remote migrations. Review `monthlyReport.md` before merging.
