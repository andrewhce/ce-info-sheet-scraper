# When a school's website will not let the dashboard in

A few schools protect their website with a **security check**: a page that says "Just a moment…" before showing the real page.
The dashboard shows these schools as **Website blocked us**. Today that is **Harvard-Westlake** (both divisions share `www.hw.com`);
the other 82 saved results were read normally.

**The dashboard never tries to get around a security check.** It does not pretend to be a person's browser, solve the check, or
hide who it is. That rule is written at the top of `src/lib/fetcher.js` ("reported as blocked, never worked around"). There are two
fair ways forward.

## 1. Save the pages yourself (works today)

A person opens the pages in their own browser, saves them, and adds the files to the dashboard. The dashboard reads the saved
files with the same rules it uses for any website. It never contacts the school's website while doing this.

1. Open the school's page in the dashboard (for example **Harvard-Westlake (Upper) School**). The box **"The website does not let
   the dashboard in…"** is already open.
2. In your **own browser**, open the school's pages that hold the answers. Good ones: admissions and how to apply, tuition and
   financial aid, key dates, "fast facts" or "at a glance", and the pages about classes and faculty. If the school has a fact sheet
   PDF, save that too.
3. On each page, **wait until it has fully loaded** (if you see "Just a moment…", wait for the real page), then press **Ctrl + S** and
   save it as **"Webpage, Complete"** (it saves the page as it looks on your screen). Add the file ending in **.html**; ignore the
   folder the browser puts beside it. If a page will not save properly, print it and choose "Save as PDF". Do not use "single file
   (.mhtml)": it is not accepted.
4. In the dashboard press **Choose saved pages…** and pick the files (several at once is fine). If you add a single file you may
   type its web address; otherwise the dashboard works it out from the file.
5. Press **Read these pages**. The answers appear on the school page, marked **"Read from pages saved by hand"**.

What to know:

- **Both divisions at once.** Schools that share a website (middle and upper) share the saved pages, and both get answers.
- **The dashboard checks each file.** It refuses a file that is itself the security-check page, a page with almost no text (it had
  not finished loading), a web address from another website, a damaged PDF, or anything that is not a web page or PDF.
- **Answers are as of the day you saved the pages.** Save the pages again and press **Read these pages** to update them.
- **A normal check will not erase them.** If someone presses "Check this website again" and the website refuses again, the answers
  from the saved pages are kept, and the page notes that the automatic attempt was refused. If the website ever lets the dashboard
  in, the normal result replaces them.
- **Files are kept on this computer** in `data/manual-pages/<website>/`. In a portable copy that is the user's own data folder.
- Limits: 15 MB per file, 60 files per website.

## 2. Ask the school to let the dashboard in (fixes it for good)

Send the school's website or admissions team a note like this (it is also on the **Help** page, under "A school's website will not
let the dashboard in"):

> Hello, we are Cardinal Education. We keep a School Information Sheet for families, using only facts that are public on schools'
> own websites. Our small program reads one page at a time, follows your robots.txt, and names itself "SchoolInfoSheetBot/1.0
> (polite research crawler; reads public school pages only)". Your website's security check currently stops it. Could your web
> team allow that name, or send us your current fact sheet (tuition, dates, enrollment, class sizes)? Thank you.

What was found for Harvard-Westlake (2026-11-17): its `robots.txt` allows ordinary pages, but its front door answers every automatic
request with a Cloudflare managed challenge (HTTP 403, `cf-mitigated: challenge`). A school's web team can allow a program by name
or by network address in Cloudflare, so a polite request has a real chance of working.
