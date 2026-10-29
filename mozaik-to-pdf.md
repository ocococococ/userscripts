# Mozaik to PDF

Easily download images (and eventually PDF built from these images) from <https://app.mozaik.co> web site for which I have an account I use with Firefox to read magazines and books.

Goal is to write a userscripts named 'mozaik-to-pdf.user.js' that will add buttons on pages with this kind of url:

<https://app.mozaik.co/press?contentId=14669> or <https://app.mozaik.co/press/14669>
14669 is an id that can obviously change.

in order to download corresponding images and build PDFs with them.

## Propose a plan to achieve this goal

Following information could help

## Misc information

When clicking 'Lire' button of <https://app.mozaik.co/press/14669>, it executes this strange url which will give access to the image viewer.

<https://presse.mozaik.co/giftedaccess/activate/?token=***&returnUrl=https://presse.mozaik.co/9adp/20261023/>

Notice returnUrl: <https://presse.mozaik.co/9adp/20261023/>
which seems to be a kind of id '9adp' followed by a parameter '20262023' here indicating a date with format yyyy-mm-dd.
=>
That returnUrl is redirected to
<https://presse.mozaik.co/france/diapason/20261023>
in order to launch an magazine/book viewer, actually it is an image viewer for all magazine/book available pages.
=>
Where for example page 34 is retrieved with this url:
<https://i.prcdn.co/img?file=9adp2026102300000000001001&page=34&scale=236&ticket=***>

In the end with a file & an ticket, an image can be downloaded with this kind of url above.
Note the scale parameter that could be adjusted to retrieve high-resolution images.
Note the file parameter seemingly build from returnUrl id & parameter.

Don't know yet how ticket parameter is generated (presumably from strange url above) but once both this ticket and the number of pages are known, it should be easy to retrieve all the pages and build a PDF from it (or in a first step a .zip archive with all images well sorted by page numbers).

XHR tabs in firefox gives this kind of calls to retrieve page keys:

<https://ingress.pressreader.com/services/IssueInfo/GetPageKeys?issue=9adp2026102300000000001001&pageNumber=0&preview=false>