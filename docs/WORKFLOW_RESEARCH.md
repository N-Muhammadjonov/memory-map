# Research and priorities

| Priority | Workflow | Users | First useful release | Reference |
|---|---|---|---|---|
| 1 | PDF annotation and citations | Researchers, students, lawyers, teachers | Highlight text inside a PDF, add a note, and open the original page from that note. Save the page, selected text, and position so the reference remains useful after backup and restore. | [Zotero PDF Reader](https://www.zotero.org/support/pdf_reader) |
| 2 | Web capture with sources | Writers, researchers, analysts, product teams | Turn a selection into a Source note with URL, title, excerpt, and date. Save to the local vault and link it to an existing project. | [Obsidian Web Clipper](https://obsidian.md/help/web-clipper) |
| 3 | Drawing dimensions and connectors | Architects, designers, engineers, teachers | Add grid and angle snapping, numeric dimensions, a drawing scale, and connectors attached to editable shapes. Export the resulting diagram as SVG. | [SketchUp measurements](https://help.sketchup.com/en/managing-units-measurement), [Goodnotes shape tools](https://support.goodnotes.com/hc/en-us/articles/13682939148943-Draw-shapes-and-build-diagrams-in-Goodnotes) |
| 4 | Saved project views | Product teams, educators, independent professionals | Save filters, grouping, and sort order for existing structured data. Add reusable views for deadlines, reading lists, design reviews, and class planning. | [Notion database views](https://www.notion.com/en-gb/help/views-filters-and-sorts) |
| 5 | Repeatable code experiments | Developers, data analysts, science and programming teachers | Add explicit run history and reproducible export. Evaluate broader local runtimes before adding dependencies and shared notebook state. | [Jupyter notebooks in VS Code](https://code.visualstudio.com/docs/datascience/jupyter-notebooks) |

## Implemented in v16

- Language detection is based on the code body, with an existing Markdown fence label as a fallback for ambiguous snippets. The Copy icon keeps a screen-reader label and reports success.
- Run executes supported Python and SQLite snippets locally. Each run starts fresh and displays output and errors under the block.
- The drawing pen recognizes confident single-stroke shapes after a short hold. The tool picker also creates preset shapes by dragging.

Test each proposed workflow with a real task. Insert a PDF quotation into a note and reopen its exact page after a restore. Save two web excerpts without duplicating their source. Export a scaled drawing and check its measured dimensions. Open the same project in two saved views. Re-run a snippet and compare its output.
