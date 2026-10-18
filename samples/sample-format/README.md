# Manual test case samples

These examples use the same three manual test cases in plain text, Markdown, CSV, and Excel formats.

## Files

- `manual-test-cases.txt` — titled cases with numbered steps.
- `manual-test-cases.md` — the same plain Markdown-compatible structure.
- `manual-test-cases.csv` — one row per step, with the case title repeated on every row.
- `manual-test-cases.xlsx` — one worksheet per case. Choose the worksheet you want to generate from when TestPilot prompts for it.

## Import notes

The current CSV importer creates a case from the first title group in the file. For CSV, use a separate file for each test case when generating cases individually. The Excel importer asks you to select a worksheet, so the workbook keeps each case on its own sheet.

Keep the `Test Case Title`, `Step`, and `Action` columns in spreadsheet files. `Expected Result` is optional and can be left blank for action-only steps.
