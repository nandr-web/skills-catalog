# How we worked

This catalog was planned and built by a small team of AI agents with distinct roles, working for one person (the owner) who reviewed proposals and made the decisions.

![Who did what, in order: the owner's notes on the PRD go to the architects, who write two readings and compare them; agent experience adds measured trials; decisions go to the owner and answers come back; QA writes the tests first; each slice goes to reviewers and comes back as a pass or fixes; then it's published](pictures/how-we-worked.svg)

## The steps

1. **The owner annotated the PRD first.** Before any design, the owner wrote notes on each section ([prd/notes.md](prd/notes.md)). The design starts from those words, not from a task list.
2. **Two architects read it independently.** Each wrote a reading without seeing the other's, then they compared point by point. Where they agreed, one line. Where they differed, the case for each side, and only real differences went to the owner. Later ideas from QA and agent-experience reached both, and the comparison says so.
3. **Decisions went to the owner as short visual summaries.** Each had one question, a recommendation and the alternatives. The owner answered in their own words, and those answers are the "decided by the owner" rows in [decisions.md](decisions.md).
4. **QA came first.** QA wrote the oracles and golden sets before the code (the [QA plan](../qa/qa-plan.md)), and its test tools were the first thing built. Every test runs in throwaway folders that clean up after themselves.
5. **The assistant's experience was measured, not guessed.** Tool names, descriptions and error wording were tried on real assistants, with success, wrong turns and token cost counted ([agent-experience.md](agent-experience.md)). Several design choices come straight from those numbers.
6. **The build went in slices, each reviewed before the next.** Each slice started from its tests, then got independent reviews (correctness, security, architecture) before the next one began. Reviews found real problems, including a cleanup routine that could delete outside its own folder and file names that collide on macOS, and they were fixed before moving on.
7. **Publish early, keep improving.** The owner chose to publish once the work was safe for others to run, then keep improving in the open.
