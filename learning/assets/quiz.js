/*
 * Retrieval-practice quiz, shared by every lesson in this workspace.
 *
 * Deliberately a *retrieval* widget rather than a multiple-choice toy: the
 * answer is revealed only after a commitment, because the effortful attempt is
 * what builds storage strength. A wrong answer is never hidden or retried away
 * — it stays struck through next to the right one, since the comparison is the
 * thing worth remembering.
 *
 * Markup contract:
 *
 *   <div class="q" data-answer="2">
 *     <p class="prompt">…</p>
 *     <div class="options">
 *       <button type="button">…</button>  ← index 0
 *       …
 *     </div>
 *     <p class="why" hidden>…</p>
 *   </div>
 *
 * `data-answer` is the 0-based index of the correct button.
 */

function wireQuestion(question) {
  const answerIndex = Number(question.dataset.answer);
  const buttons = [...question.querySelectorAll('.options button')];
  const why = question.querySelector('.why');

  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      // One commitment per question: lock everything the moment a choice lands.
      buttons.forEach((other, otherIndex) => {
        other.disabled = true;
        if (otherIndex === answerIndex) other.dataset.state = 'right';
      });

      if (index !== answerIndex) button.dataset.state = 'wrong';

      if (why) {
        why.hidden = false;
        // Announce the explanation for screen readers, which otherwise get no
        // signal that anything changed below the button they just pressed.
        why.setAttribute('role', 'status');
      }
    });
  });
}

document.querySelectorAll('.q').forEach(wireQuestion);
