# Where an answer comes from

Every answer shows the page it came from. The sources are used in this order, and a later source only fills a question that the
earlier ones left empty. It never replaces an answer.

| Order | Source | How it is read |
| --- | --- | --- |
| 1 | The school's own website (and its PDFs) | Automatically, by the scraper. Or from pages saved by hand when the site blocks the scraper. |
| 2 | Ravenna (the school's own application platform) | From a page a person saved. |
| 3 | Niche | From a page a person saved. |
| 4 | Private School Review and Boarding School Review | From a page a person saved. |

An answer filled from sources 2 to 4 is marked on the school's page ("From Niche (saved page)"), says in its note that the
school's website did not give it, links to the saved page's own web address, gets a lower trust score than a website answer
(the trust score looks at where an answer came from), and appears in the Excel export and in the Ask page with the same note.

## Why the pages are saved by hand

The dashboard never contacts Niche, Private School Review, Boarding School Review or Ravenna.

- **Niche** answers automatic readers with an "Access to this page has been denied" page. The dashboard does not work around
  security checks.
- **Private School Review** (and Boarding School Review, which is built the same way) say in their terms of use that visitors
  agree not to access their service "through any automated, unethical or unconventional means".
- **Ravenna** needs a person's own sign-in.

So a person opens the school's page in their own browser, saves it, and adds the file. Reading a file the person saved is not
contacting the site. If a site is ever allowed to be read automatically (for example through a data licence), this is the
place to change.

## How to add pages

1. Open **Ravenna & reviews** in the menu and choose the source (Ravenna, Niche, Private School Review, Boarding School Review).
2. On the school's row press **Open in Ravenna** (the link from your sheet) or **Find on Niche** (a web search for the school).
3. In your own browser, sign in if needed, wait until the page has fully loaded, press **Ctrl + S** and save it as
   "Webpage, HTML only". Add the .html file (not the folder next to it). A PDF printout also works.
4. Add the file on the school's row, or drag many files into the box at the top: each is matched to its school by the school's
   name on the page. Pages that cannot be matched (for example "Castilleja School" when the sheet has an Upper and a Middle
   school) are listed so they can be added from the right row.

### The one-click save button

On the same page, **One-click save button** gives a bookmark ("★ Save to School Info") to drag onto the browser's bookmarks bar
once. After that, on a Niche, Private School Review, Boarding School Review or Ravenna page you are looking at, one click:

1. opens a small dashboard window (the dashboard's `#/receive` page),
2. hands it the page you are looking at (by `postMessage`, so the website's own security rules do not get in the way),
3. the window finds the school by name, adds the page and says how many answers it filled. If it cannot tell which school (two
   divisions fit, or none does) it asks you to choose; it still refuses a school that does not fit the page.

You open each page yourself, so this is the same as saving it with Ctrl + S, only quicker. The dashboard never opens these sites.
The window accepts pages only from these four sites over https (anything else is ignored), and the bookmark sends the page only
to the dashboard's own address. If the dashboard does not answer within 15 seconds (it is closed, you are not signed in, or the
site stops pop-ups from talking to other windows) or pop-ups are blocked, the bookmark saves the page as a file in the
Downloads folder instead, to be added by hand. The bookmark contains the dashboard's address, so one made on a personal computer
(`localhost`) does not work for the online copy, and the other way round.

A page is refused, with a plain explanation, when it is a security-check page, nearly empty, a "single file" web archive
(.mhtml), from another site than the one chosen, or about a different school than the row it is added to.

Up to 10 pages per school and source, 15 MB each. The answers are applied at once, after every later check of the website, and
taken away again when the page is removed.

## What is read from a saved page

Only labelled facts, never loose sentences, because these pages also show figures for nearby schools, state averages and
rankings. Examples: "Student-Teacher Ratio: 7:1", "Yearly Tuition Cost: $59,600", "Grades Offered: Grades 6-12",
"Average Class Size: 15 students", "% Faculty w/Advanced Degree: 87%", the average SAT and ACT scores, the sports list, the
religious affiliation and student body type (for School Type), the application deadline, and the address in the page's
structured data.

- **Private School Review and Boarding School Review** use one layout. Its facts table was checked against a real page, and
  nothing else on the page is read.
- **Niche** was checked against a real saved page (AEON School). Niche words things its own way, so the reader maps Niche's
  words to the template's rows:

  | Niche says | Template row |
  | --- | --- |
  | the grades under the school's name ("5-12") | Grades |
  | the tags under About ("Private", "Online School") | School Type |
  | "NAIS Member" and similar tags | Partnering Organizations/Groups |
  | the address block under About | Location |
  | "Students" | Total Student Enrollment |
  | "Student-Teacher Ratio" | Student-Teacher Ratio |
  | "Yearly Tuition" (with the share on aid and the average aid in the note) | Tuition |
  | "Average SAT", "Average ACT" (user-reported, said in the note) | Average Standardized test scores |
  | "Application Deadline" | Application Timeline |
  | "Application Fee" | Application |
  | "Interview Required" | Interviews |
  | "Required/Recommended Tests" | Testing Policy |
  | "From <school>" (the school's own text) | About the School |
  | "Academics at <school>" (the school's own text) | Academics |

  Niche puts a one-sentence explanation between a label and its value, and its page code marks the whole content area as
  navigation; both are handled. Niche's own office address (in the page's structured data) is never used as the school's.
  Answers keep Niche's own words ("Interview Required: Yes"). When a division school (Upper, Middle) is filled from a page about
  the whole school, the answers carry a note to check that the figure applies to that division.
- **Ravenna** uses a general reader: definition lists, two-column table rows, label and value elements with matching class
  names, and "Label: value" lines. It has not been tuned on a real saved page yet: if a page shows "nothing read" on the Ravenna
  & reviews page, send that file so the reader can be set up for its layout.
- **Ravenna** pages are also read with the same rules as school websites, but only for application questions (open and decision
  dates, steps, recommendations, transcripts, testing policy, interviews, essays, events, tuition).

## Adding a school without the whole sheet

On the **Schools** page, open **Add a school that is not in your sheet**, type the name (the website, tier, region and a
Ravenna link are optional) and the school joins the list at once. Loading the whole sheet later keeps schools added this way
unless the sheet lists them itself. A school added by hand can be removed again from the saved list, never a school from the
sheet.
