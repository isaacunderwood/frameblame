# Starting floor: reads a LoAF frame, has not yet met the event loop

Isaac arrived at this workspace already able to read a real LoAF entry field by field — he had
just spent a session collecting them, and could follow a walkthrough of `startTime`,
`firstUIEventTimestamp`, the single merged script entry, the collapse of
`renderStart`/`styleAndLayoutStart`/`paintTime`, and the fact that `duration` stops at
`paintTime` with presentation outside it. Teaching any of that again would be coverage, not
learning.

What he had *not* met is the machinery underneath: the event loop's "update the rendering"
step, its ordering, and the reason style and layout are absent from it. That gap is what
Lesson 01 fills, and it was chosen because it generalises what he already knows about one
frame into the model every other performance API hangs off.

**Evidence:** he has been making design decisions against this data for a full working session
— including correctly identifying that an unattributed slice must be a first-class output — but
an adversarial review found he had accepted an inverted claim about React's instrumentation and
had not tested a production build. The pattern is strong empirical instinct running ahead of
settled mechanism knowledge, which is exactly what this mission is for.

**Implications:** lessons should start from his own measured data rather than toy examples, and
should favour the "why does the API behave this way" angle over the "how do I call it" angle.
He will not be satisfied by a rule he cannot derive.
