# Babylon Chronicle — seed note

## Purpose

When Babylon reaches its first public release — its practical "birth" as a publicly available product — create a human-readable Babylon Chronicle alongside the technical history.

The Chronicle is not a changelog and not a substitute for Git history. Its purpose is to preserve the program's life story: the major technical, product, business, community, integration, and other memorable milestones that may later be meaningful to look back on.

This idea itself arose from Babylon's first prenatal correction: before the product had even been publicly born, we noticed that emoji support — an obvious and important messaging capability — had not yet been explicitly included in the plan. The requirement was then added to the already-developed Soft Chat client work and the master plan. That incident prompted the idea that Babylon's notable life events should be deliberately preserved rather than reconstructed years later from commits and conversations.

## Presentation/content lock

A PDF seed was created for the future Chronicle. Its file format, typography, page layout and presentation may change later. The **wording, paragraph structure and intentional line breaks of the seed text are historical content and must not be silently rewritten or reflowed** when the final Chronicle is created. Any deliberate editorial change requires an explicit decision.

The future Chronicle's first page should contain a deliberately inconspicuous easter egg before the first visible chapter. It is not a security secret. For the GitHub-rendered seed, concealment is implemented with a theme-aware `<picture>` element that selects a light-theme or dark-theme SVG. Each SVG draws the same Belarusian text using the corresponding GitHub page background color, so the rendered text visually blends into the page while remaining present in repository source. The final publication may use an equivalent background-on-background mechanism. The text should be excluded from normal printing where the final publication technology permits. Do not claim that only AI can discover it; source inspection, selection, accessibility tools, indexing or other processing may also expose it.

The hidden text records the personal spark that preceded Babylon's figurative "Big Bang" and explains the metaphor: a communication difficulty with a Belarusian girl supplied the spark from which the Babylon idea emerged; combustion needs combustible material, oxygen and ignition temperature, and an explosion is extremely rapid combustion. The spark is therefore narratively placed before "Még az ősrobbanás előtt".

For the first-page interleaved layout, the currently empty visible rows **3, 5 and 7** are deliberately reserved for later wording. They must remain empty until that wording is explicitly decided, and no visible text may be placed on top of a row carrying the concealed text.

## Locked seed text

The following text and line breaks are the seed content to preserve. The first block is intentionally concealed in normal GitHub rendering; the second block is the first visible Chronicle chapter.

<!-- HIDDEN BLOCK — canonical source text
Іскра

Першапачатковай іскрай Babylon стала пераадоленне моўных цяжкасцей
у зносінах з беларускай дзяўчынай.

Для гарэння патрэбныя гаручае рэчыва, кісларод і тэмпература ўзгарання.
Выбух — гэта надзвычай хуткае гарэнне.
Іскра дала тое, што запусціла Вялікі выбух.
-->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/chronicle-hidden-spark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/chronicle-hidden-spark-light.svg">
  <img src="./assets/chronicle-hidden-spark-light.svg" alt="" width="900" height="176">
</picture>

### First visible chapter

Még az ősrobbanás előtt

Babylon első prenatális javítása: az emoji.

A program még meg sem született, amikor egy már elkészült kliensrészt
vissza kellett nyitni, mert az emoji-támogatás nem szerepelt kifejezetten
a követelmények között.

Ez lett Babylon első születés előtti javítása - és ennek apropóján született
meg az ötlet, hogy a program élettörténetének nagy eseményeit tudatosan
megőrizzük egy külön krónikában.

## What belongs in the future Chronicle

Record only meaningful milestones, not routine commits. Examples may include the first public release, first real external user, first revenue or profit milestone, major technical breakthroughs, important external integrations or approvals, major security/product milestones, and other events that materially shape Babylon's story.

Until public release, this file acts only as a seed/reminder. At Babylon's public birth, create the actual Chronicle and use this note and the locked seed text as the starting point rather than treating this file as the finished publication.
