# Monthly maintenance

The workflow runs on the first day of each month at 02:00 America/Indiana/Indianapolis, with UTC schedule candidates and a local-time gate for daylight saving. Manual runs bypass that gate. It updates monthly-maintenance and opens or updates a pull request to master.

The workflow applies in-range dependency updates, checks repository privacy, runs tests, build/migration/integration checks, dependency audits and static checks, and preserves monthlyReport.md with plain-language findings and redacted evidence. Optional browser and Lighthouse commands remain configurable.

To email the report, configure GitHub secrets RESEND_API_KEY, RESEND_FROM_EMAIL, and MAINTENANCE_TO_EMAIL. Missing values skip email with a workflow notice. Report delivery is performed by the workflow, not during implementation.

The workflow does not auto-merge, deploy or apply remote database migrations. Review the report and diff before merging. Launch-validation CI independently checks pushes and pull requests to master.
