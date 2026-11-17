# Checking how accurate the scraper is

> You do not have to check everything. The **Review** tab already ranks every key fact by how much to trust it; spot-checks are how you test that ranking and keep it honest.

The dashboard can show how often the scraper's answers agree with your sheet, but **agreement is not accuracy**: the sheet can be old, and
two loose text matches can agree while both are wrong. Real accuracy comes from a person checking values against each school's own website.
That is what the **Accuracy** tab and the spot-check buttons are for.

## How to check

1. Open **Accuracy** and press **Draw a sample of 30 schools**. It picks schools the scraper read successfully, spread across the tiers in
   proportion, and asks about the 12 fields that matter most: tuition, enrollment, student-teacher ratio, class size, faculty degrees,
   location, grades, the two application dates, college enrollment %, counselors and test scores. (All 360 checks take roughly 6 to 8 hours:
   do them in pieces. Every check counts straight away.)
2. Open a school from the list. Under each value the scraper found, press **✓ Right** or **✗ Wrong** (for a wrong one you can type the right
   value and the page where you found it). Where the scraper found nothing, press **Not on the site** (blank is correct) or **It is on the
   site (missed)**.
3. Read the **Accuracy** tab: for each field, how often the scraper is **right when it answers**, with a 95% range, and how often it
   **finds what is there**.

You can also spot-check any school at any time, outside a sample.

## Reading the figures

| Figure | Meaning |
| --- | --- |
| Checks | How many values a person has checked for that field. |
| Right when it answers | Of the values the scraper found, how many were right. This is the number to trust or not. |
| 95% range | With few checks the true rate could be quite different; the range shows how wide that doubt is. Five out of five is not proof of 100%. |
| Finds what is there | Of the facts that really are on the site (right answers, plus wrong or missing ones where you gave the true value), how many it got right. |
| Verdict | Reliable (95% or more right when it answers), Review before using (85 to 95%), Always review (under 85%), or Needs more checks (fewer than 10 answered checks). These are rules of thumb, not guarantees. |

**Does the trust score work?** A second table groups the checks by the trust level the value had when you checked it (Safe to use, Quick look, Check this). If the score works, Safe to use values are right far more often than Check this ones. This is the independent test of the score, because the checks come from a person reading the school's own site, not from the sheet. See [TRUST.md](TRUST.md).

Your checks also tune the score: once a field has 10 or more Right / Wrong checks, the field's own record replaces the starting number.

**Mistakes to fix.** Every wrong or missed value is listed with what the scraper said and the right value you entered: this is the to-do list
for improving the rules. Add each one as a test in `tests/rules.test.js` so it stays fixed.

## A check goes stale when the answer changes

A check remembers what the scraper had when you made it. If a later scrape changes that value, the old verdict no longer applies: the
school page asks you to check it again, and the Accuracy tab counts it separately and leaves it out of every figure. (A re-scrape that gives
the same value keeps your check.)

## Where things are saved

Checks and the current sample are in `data/verification.json` on this computer (the data folder is never published). **Download the answer key**
at the bottom of the Accuracy tab for a file listing every check with the right value and what the scraper had. Keep it: it is the answer key
for testing future versions of the rules.

## Good practice

- Check against the school's **own** website or PDF, not a third-party site or the sheet.
- Do not tune the rules to the sample schools only. Fix a mistake by understanding why it happened, then re-check on other schools.
- Draw a fresh sample after big rule changes, and spot-check 5 to 10 percent of every new batch you scrape.
- Fields with few checks (under 10) are hints. Spend your next checks where the range is widest or the rate is lowest.
