# Review Comments for `README.md`

<review_item id="r-4013532fc9" status="resolved">
<location>
File: `README.md`
Lines: 15-27
</location>

<target_code>
```md
```mermaid
flowchart LR
    A[Open AI-generated file] --> B[Review File command]
    B --> C[Add inline comments]
    C --> D{Accept / Reject?}
    D -->|Accepted| E[Click Iterate]
    D -->|Rejected| C
    E --> F[Agent reads sidecar & updates file]
    F --> G[Diff Changes]
    G --> H{Satisfied?}
    H -->|No| C
    H -->|Yes| I[Approve & Handoff]
```
```
</target_code>

<comment author="You">
The changes look good add the images in the docs folder.
</comment>

<comment author="Agent">
Updated the image placeholders to point to `docs/Review a file.PNG`, `docs/Comment.PNG`, and `docs/Claude response.PNG`.
</comment>
</review_item>

<!-- COSTEER_RESOLVED_START

<review_item id="r-911e8fe61b" status="resolved">
<location>
File: `README.md`
Lines: 13-13
</location>

<target_code>
```md
## How it Works
```
</target_code>

<comment author="You">
We need to improve the instruction and add pictures. Please comment with your ideas on how to impreove the instructions
</comment>

<comment author="Agent">
Here are my ideas for improving the instructions:
1. **Flowchart Overview**: Add a Mermaid diagram right after the "## How it Works" header to give a quick visual representation of the `Review -> Comment -> Iterate -> Approve` workflow.
2. **Break down the steps**: Group the 7 steps into 3 clear phases: **Review & Comment**, **Agent Iteration**, and **Approval & Handoff**.
3. **Pictures**: Add screenshot placeholders for key interactions:
   - `![Starting a Review](assets/start-review.png)` (after step 1)
   - `![Adding an Inline Comment](assets/inline-comment.png)` (after step 2)
   - `![Agent Iteration Diff](assets/diff-view.png)` (after step 5)
Let me know if you'd like me to implement these structural changes in `README.md` with placeholders!
</comment>

<comment author="Agent">
Implemented: added a Mermaid flowchart after the section header, grouped the 7 steps into 3 phases (Review & Comment, Agent Iteration, Approval & Handoff), and inserted screenshot placeholders for `assets/start-review.png`, `assets/inline-comment.png`, and `assets/diff-view.png`. Also added `repository` field to `package.json` to resolve relative-image-URL linter warnings.
</comment>

<comment author="You">
I am not sure I love this work please improve it
</comment>
</review_item>

COSTEER_RESOLVED_END -->
