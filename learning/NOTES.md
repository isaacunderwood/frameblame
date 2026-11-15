# Working notes

Preferences and practicalities. Not learning content — see `learning-records/` for that.

## How Isaac wants to be taught

- **One question at a time.** Never batch questions; ask, wait for the answer, then ask the
  next. This holds for teaching too: one retrieval prompt at a time beats a wall of them.
- **Give the decisive reason in a line or two**, not a trade-off essay. Applies to explanations
  as much as to recommendations.
- **Lessons are published as Artifacts**, requested explicitly in the first session. The HTML
  file in `lessons/` stays the workspace's source of record; the artifact is what he reads.

## Workspace conventions

- The workspace lives in `learning/` inside the `frameblame` repo rather than at the repo root,
  so it does not clutter a project that strangers will judge. All skill paths are rooted here.
- `lessons/assets` and `lessons/reference` are symlinks to their siblings, so one set of
  relative paths works both locally and when published as a multi-file artifact.
- Lessons and reference sheets share `assets/lesson.css` and `assets/quiz.js`. Extend the
  components rather than inlining anything a second lesson would duplicate.
- The palette is load-bearing vocabulary, not decoration: amber means script, teal means the
  rendering update, red flags a trap. Keep it consistent across lessons and diagrams.

## Pending

- **No glossary yet.** The skill's rule is that a term is promoted only once Isaac can use it
  correctly, not when it has been introduced. Lesson 01's quiz is the first evidence; build
  `GLOSSARY.md` once there are a handful of terms that have earned their place.
- **Communities not yet discussed.** He has not been asked whether he wants to join any. Ask
  before proposing, and record the answer in `RESOURCES.md`.
