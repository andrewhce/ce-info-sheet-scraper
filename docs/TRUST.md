# The trust score

Researchers should not re-read every value the scraper finds. Each **key fact** carries a **trust score from 1 to 99**, worked out
automatically from **where the value came from** and **how plainly the page states it**. The **Review** tab lists only the values the score is
unsure about, most doubtful first. Everything at **Safe to use** can be copied without a second look.

| Level | Score | What to do |
| --- | --- | --- |
| **Safe to use** | 88 and up | Use it. No check needed. |
| **Quick look** | 65 to 87 | Glance at the quote and the page it came from. |
| **Check this** | under 65 | A person should look: it is probably wrong, or too thin to tell. |

Only the 11 key facts are scored (tuition, total enrollment, student-teacher ratio, class size, faculty degrees, college enrollment, counselors,
location, grades, application open date, decision date). Copied text such as the mission statement or "about" paragraphs is not scored: there
is nothing to be right or wrong about.

## The score does not use your sheet

The sheet can be old or wrong, so agreeing with it proves little and disagreeing with it proves nothing. A value is trusted for its **source**,
not for matching a spreadsheet. (The Schools page still shows the side-by-side comparison with the sheet; it just has no say in the score.)

## Where a value came from

This is the biggest part of the score. The best page the value was found on counts.

| Source | Effect | Examples |
| --- | --- | --- |
| **The school's own fact sheet or profile** | very reliable: up a lot | an "At a Glance" or "Facts" page, a school profile PDF |
| **The school's own page about that exact topic** | reliable: up | the tuition page for tuition, the college counseling page for counselors, the contact page for the address, the dates / how-to-apply page for dates |
| A page that touches on the topic | up a little | the admissions page for a headcount |
| A general page | down a little | the home page, a page about something else |
| A news, blog or events post | down | only when nothing better is listed |

## How plainly the page states it

| Evidence | Effect |
| --- | --- |
| The quote the scraper saved really shows the number (a word such as "five" counts) | up |
| The quote does not show the number | down a lot |
| **Counted** from job titles instead of a number the school states (counselors) | down a lot |
| The same value is stated on 2, 3 or 5+ pages of the school's site | up, more with more pages |
| Another page gives a different value | down |
| The school's own pages give two answers of nearly equal weight | down, and always sent to a person |
| School year on the page is the current one (older: down; none shown: down) | up / down |
| The page does not say which division (lower, middle, upper) a number covers | down a lot |
| A count of only the day or only the boarding students | down |
| An impossible value (tuition of $500) or an unusual one (class size 40) | down a lot / down |
| A date with its year that fits this admission cycle (cycles turn over July 1) | up |
| A date from before this cycle, or only a month, or no year | down |
| An early-round or late-applicant date, used only because the main date was not found | down a lot |
| The school's own pages label this campus for this division | up |
| Several campuses are listed and nothing says which one this division uses | down |
| An address with a different postal code on the same site (it may be another campus) | down |
| The rule's own High / Medium / Low mark | almost nothing (it did not predict accuracy when measured) |
| The website in your list looks like a **different school** | capped at 5: nothing is trusted |

For grades, other ranges on the page are other divisions, and for addresses another address in the same postal code is normal, so neither counts
as a conflict.

A field that is hard to read (counselors, total enrollment, student-teacher ratio) needs a very reliable source *and* a plain statement to reach
Safe to use. A counselors figure counted from job titles never does.

## Where the numbers come from, and what that does not prove

Nothing in the score has been measured against real accuracy yet. The starting number for each field is a **judgement of how plainly the rule can
read it** (a labelled grade range is easy; a headcount that may cover one division or the whole school is not), and the size of each move is a
judgement of how much that evidence matters. They were not fitted to your sheet.

Your **Right / Wrong** spot-checks are the real yardstick. Each check is saved with the score the value had, and the Accuracy tab shows whether
Safe to use values really are right more often than Check this ones. Once a field has **10 or more** checks, that field's own record replaces the
starting number (the reason line then says "Your spot-checks"), so the score improves the more the team uses the buttons.

What the score **cannot** catch is a rule reading the wrong number from a good source: a fact sheet can still be misread. That is why Safe to use
means "the evidence is strong", not "certain", and why a few spot-checks on Safe to use values are worth doing.

## Where you see it

- **Review**: the work list, filterable by tier, level and field, with a link to the page each value came from. Checked values leave the list.
  Schools whose listed website looks like a different school are left out (fix the website first).
- **School page**: a chip under each found value with **Why this score**, plus the filters *Facts to look at* and *Facts ready to use*.
  Key facts show the trust chip instead of the old "Strong match / Likely match" mark (that mark only said how the rule matched the text);
  copied text sections keep it.
- **Schools**: a **Facts to look at** column.
- **Excel / CSV export**: the old *Confidence* column is now **Trust** (for example `Safe to use (99)`); values that are not ready also get a
  `Why:` note.
- **Accuracy**: the *Does the trust score work?* table.

## Rule fixes that came out of the first review

Reading why values were flagged found real mistakes in the rules, which are fixed (each has a test in `tests/rules.test.js`):

- **Student-teacher ratio** matched the word "collaboration" and a clock time (`10:00 AM`) as if they were ratios.
- **Total enrollment** took an area code from a phone number (`(650) 851-6158`), a graduating class (`Class of 2026 enrollment 113`), and the number of AP exams
  (`Total Exams: 2,564`) instead of the students. It now reads `Total Students: 947`, and a day-only or boarding-only count loses to the whole-school number.
- **Decision date** preferred an early-action date over the regular one, and read a late-applicant sentence. Early rounds are now used only when no main date exists, and are flagged.
- **Application open date** took an open-house date, and a lower school's kindergarten calendar for middle and upper school pages.
- **Counselors**: "our five counselors" on the college counseling page is now read as a stated number, and a count of job titles now carries its number.
- **Location** for schools with several campuses: a short label near the address ("BETHESDA CAMPUS (LOWER SCHOOL)", "San Mateo Campus (Grades 9–12)") now decides the campus. Sidwell's Lower School is now Bethesda, Nueva's Upper School is San Mateo, and Crystal Springs' Upper School is Hillsborough.

These only change a school's saved values when it is scraped again (the 82 already-scraped schools were re-read from their saved pages, with no new downloads).

## Known limits

- Counselors fill the queue because the scraper really is unreliable there: a school's own "four college counselors" and a count of job titles
  are both guesses at what a researcher counts. Use the field buttons on the Review tab to work through one field at a time.
- Total enrollment is the other big one: many schools give one headcount for the whole school and the sheet wants it per division.
- A school with several campuses is read from the school's own labels ("Short Hills Campus: Grades K-5", "Grade 6 through Grade 8 in Basking Ridge"). When the site
  labels the campus for the division, the address scores higher; when it lists several campuses and nothing says which one the division uses, the address is
  marked down and the note says to check which campus.
- Google Sheet export and the Ask assistant do not use the score yet.

The code is in `src/lib/trust.js` (the model) and `src/lib/review-queue.js` (the list). Tests: `node tests/trust.test.js`.
