# How reliable are the answers? A simulation

Made on 2026-11-17 from 81 checked schools and 484 answers to the main questions (5,000 simulated runs for each test, seed 20261117). 1 school was left out because the website link looks like a different school.

## The short version

- **271 of the 484 answers are rated “Safe to use”.** If nobody checked them, we would expect about **32 of them to be wrong** (11.8%), plausibly anywhere from 14 to 61. That depends on how honest the ratings are, which nobody knows yet: if they mean exactly what they say it would be about 20, and if they are clearly too optimistic about 71.
- **Checking the 213 answers that are not “Safe to use”** (the “To check” page) would leave about 36 wrong answers in all 484 (17 to 67), assuming a careful person catches 95% of the mistakes they look at.
- **To learn the real accuracy** of the Safe to use answers: about 200 checks if it is really 90% right, about 150 checks if it is really 95% right, about 75 checks if it is really 98% right (that many checks gives an 80% chance of being within 5 points). To see whether the ratings mean anything, about 50 checks in each of the two groups is enough.
- **The ratings depend on my judgement, and about 34% of the Safe to use answers sit close enough to the line that a modest change in judgement would make them “Quick look”** (93 of 271). The rest are steady (section 4).

**What this cannot do:** it cannot tell you the true accuracy. Nobody has checked these answers against the real websites yet. The simulation turns a clearly stated range of guesses into a range of outcomes to plan for. Only your ✓ Right and ✗ Wrong checks can replace the guesses with facts.

## 1. If nobody checked the “Safe to use” answers, how many would be wrong?

The 1 to 100 rating is meant to be the chance an answer is right, but it has never been checked. So in every simulated run the ratings are allowed to be a bit too optimistic or about right, and each question can have its own hidden problem (for example, a rule that misreads phone numbers is wrong at every school). Then every answer is randomly right or wrong according to that run’s chances.

Across 5,000 runs, among the 271 “Safe to use” answers, under three guesses about how honest the ratings are:

| If the ratings are… | Wrong answers (most likely) | Plausible range (90% of runs) | Share wrong |
| --- | --- | --- | --- |
| exactly honest | 20 | 12 to 30 | 7.4% |
| somewhat too optimistic (used for the short version) | 32 | 14 to 61 | 11.8% |
| clearly too optimistic | 71 | 34 to 122 | 26.2% |

By question (among the answers rated Safe to use, in the middle guess):

| Question | Safe to use answers | Expected wrong | Plausible range |
| --- | --- | --- | --- |
| Tuition | 59 | 7.1 | 1 to 17 |
| Address | 44 | 5.5 | 1 to 13 |
| Grades | 42 | 5.2 | 1 to 12 |
| Decision release date | 25 | 4.0 | 0 to 9 |
| Faculty with advanced degrees | 24 | 3.0 | 0 to 7 |
| Application open date | 18 | 2.5 | 0 to 6 |
| Class size | 25 | 2.4 | 0 to 6 |
| Student-teacher ratio | 14 | 1.6 | 0 to 4 |
| College enrollment % | 12 | 1.2 | 0 to 4 |
| Total enrollment | 8 | 1.2 | 0 to 3 |

## 2. How much checking is worth it?

You choose where to draw the line: answers rated below the line get checked by a person, answers above it are used as they are (middle guess).

| Check answers rated below | Answers to check | Wrong answers left (most likely) | Plausible range |
| --- | --- | --- | --- |
| 60 | 52 | 82 | 44 to 136 |
| 70 | 93 | 66 | 34 to 113 |
| 80 | 139 | 51 | 25 to 92 |
| 88 (today) | 213 | 36 | 17 to 67 |
| 92 | 309 | 21 | 9 to 41 |
| 95 | 398 | 11 | 5 to 21 |
| 98 | 478 | 6 | 4 to 9 |

Wrong answers left include the ones in answers nobody looks at, plus the few (5%) that a person misses when checking. Even checking everything would leave about 6, because people miss some. The “To check” page lists exactly the answers below the line, least certain first.

## 3. How many answers do you need to check by hand to learn the real accuracy?

This plays out random spot-checks of the 271 “Safe to use” answers. The “typical margin” is how far the percentage on the Accuracy page is likely to be from the truth (a 95% margin).

| Answers checked | Typical margin if the real accuracy is 90% / 95% / 98% |
| --- | --- |
| 20 | ±13.7 / ±11.4 / ±8.1 points |
| 30 | ±11.1 / ±8.0 / ±5.7 points |
| 50 | ±8.5 / ±6.2 / ±5.1 points |
| 75 | ±6.7 / ±5.4 / ±3.5 points |
| 100 | ±6.0 / ±4.5 / ±3.2 points |
| 150 | ±4.8 / ±3.5 / ±2.5 points |
| 200 | ±4.2 / ±3.1 / ±2.1 points |
| 271 | ±3.6 / ±2.6 / ±1.7 points |

Chance of being within 5 points:

| Answers checked | if really 90% | if really 95% | if really 98% |
| --- | --- | --- | --- |
| 20 | 0% | 0% | 0% |
| 30 | 0% | 0% | 0% |
| 50 | 1% | 8% | 37% |
| 75 | 5% | 47% | 94% |
| 100 | 12% | 77% | 100% |
| 150 | 68% | 100% | 100% |
| 200 | 99% | 100% | 100% |
| 271 | 100% | 100% | 100% |

Can the Accuracy page tell “Safe to use” from “Check this”? If Safe to use answers are really right 95% of the time and Check this ones 60%, this is the chance the two margins do not overlap after checking this many of each:

| Checked in each group | Chance the page shows a clear difference |
| --- | --- |
| 20 | 45% |
| 30 | 75% |
| 50 | 96% |
| 75 | 100% |
| 100 | 100% |
| 150 | 100% |
| 200 | 100% |
| 271 | 100% |

Rule of thumb: about 50 checks in each group is enough to see whether the ratings mean anything; a precise accuracy figure needs more, and the more accurate the answers really are, the fewer checks that takes.

## 4. What if my judgement is off?

The rating uses weights I chose by judgement (how much a fact sheet counts, how much a missing school year costs, and so on). To see how much that matters, every weight was changed at random by roughly ±35% and every starting number moved, 1,000 times, and every answer was rated again.

- Today 271 answers are “Safe to use”. Across the variations the count is typically **266** (198 to 320).
- 87 of today’s Safe to use answers stay Safe to use in at least 95% of the variations, 91 in 80% to 95%, and 93 in fewer than 80%. The shaky ones all have ratings between 88 and 90: they sit right at the line of 88, so a small change in judgement tips them over. Answers rated well above the line stay put.

The most sensitive judgements (the number of Safe to use answers when this one weight is halved, and when it is raised by half):

| Judgement | Safe to use if halved | if raised by half |
| --- | --- | --- |
| the school’s own page on the topic counting as reliable | 233 | 284 |
| a page that only touches the topic | 256 | 291 |
| a date with a fitting year | 244 | 277 |
| the quote showing the number | 256 | 286 |
| the school’s own fact sheet counting as very reliable | 260 | 280 |
| several campuses with no label | 286 | 271 |

Questions whose Safe to use answers are least steady:

| Question | Safe to use | Steady in 95% of variations |
| --- | --- | --- |
| Decision release date | 25 | 0 |
| Total enrollment | 8 | 0 |
| Tuition | 59 | 12 |
| Address | 44 | 11 |
| Application open date | 18 | 6 |
| Student-teacher ratio | 14 | 5 |

## What to do with this

1. Pick the “check answers rated below” line from section 2 that matches how much checking time you have. 88 is the line today.
2. Check about 50 “Safe to use” answers spread across different questions (open any school and press ✓ Right or ✗ Wrong), and about as many “Check this” ones. If several Safe to use answers turn out wrong, tell whoever looks after the dashboard: a rule has a problem, as the phone-number mistake did.
3. Run this again after you have made checks (`node tools/monte-carlo.js`). Real checks then replace the guesses in section 1.

## The guesses behind the numbers

- **honest:** ratings shifted by 0 (give or take 0.15) and spread between 95% and 105% of what they say; a hidden problem per question of typical size 0.2; a person catches 95% of the mistakes in answers they check.
- **middle:** ratings shifted by -0.25 (give or take 0.4) and spread between 75% and 110% of what they say; a hidden problem per question of typical size 0.5; a person catches 95% of the mistakes in answers they check.
- **optimistic:** ratings shifted by -0.7 (give or take 0.4) and spread between 50% and 90% of what they say; a hidden problem per question of typical size 0.7; a person catches 95% of the mistakes in answers they check.
- Answers are treated as independent apart from the per-question effect.
- Changing these guesses changes the numbers. They are written at the top of `tools/monte-carlo.js` so they can be changed and the report remade.
