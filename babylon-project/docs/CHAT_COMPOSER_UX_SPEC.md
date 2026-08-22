# Babylon Chat Composer UX — discussion draft

Status: product/UX decisions captured for later detailed review. This document records intent; unresolved interaction details remain open until implementation planning.

## Composer-area controls

Place the primary message-composer controls immediately around the chat input area, in a layout suitable for touch use with generous separation and hit targets so adjacent controls are not triggered accidentally by larger fingers.

Required nearby controls/entry points:

- attachment/paperclip control for ordinary file/image attachment;
- emoji/smiley control that opens the emoji picker;
- protection/enhanced-handling control for choosing the applicable attachment protection mode(s), visually distinct from ordinary attachment selection even if a paperclip-like icon is ultimately used;
- explicit wording/style selector near the composer when that feature becomes functional;
- send control for committing text and any staged object/attachment preview.

The precise iconography, order and spacing are intentionally left for later UX review, but all controls should remain easily reachable and clearly separated on touchscreens.

## Keyboard behavior

When the user focuses the text input on a mobile/touch device, the system keyboard should appear naturally and the conversation/composer area should reflow or shift so the active input and its nearby controls remain visible and usable.

## Object/attachment path is separate from text transformation

Object sending is independent of whether the current text path is Soft Chat or an explicitly selected translated/styled mode. Files and images are transport objects, not text-transformation payloads.

The same attachment/protection capabilities must remain available when the surrounding text message is Soft Chat. Attachment binaries and filenames remain unchanged by translation/style processing, consistent with the master-plan attachment rules.

## Drag-and-drop and paste staging

Desktop-capable clients should support drag-and-drop for images/files into the conversation/composer region. The user should not need to hit a tiny exact target: dropping anywhere in an accepted composer/conversation drop zone should stage the object into the composer.

For images, staging should show a thumbnail/preview in or immediately attached to the composer so the user can verify that the intended image was selected before sending.

Staging an object must not send it automatically. The existing send action commits the staged object/message.

Clipboard paste should be supported where the platform provides it. Pasted images should be staged as image objects with preview rather than silently sent. Text paste should remain ordinary editable composer text; it must not create a separate object attachment.

## Open discussion items

The following need explicit review before implementation:

1. final control order, iconography and grouping around the composer;
2. whether ordinary attachment selection and protection-mode selection use one expandable control or two visually distinct controls;
3. exact minimum touch-target size and spacing per platform;
4. accepted drag-and-drop region on desktop (composer only vs. wider conversation surface);
5. paste behavior for mixed clipboard payloads containing both text and image data;
6. multi-object staging behavior, ordering and removal before send;
7. how protection-mode selection is represented on each staged object when multiple objects are queued;
8. responsive behavior when the mobile keyboard opens, especially on small screens.
