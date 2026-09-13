# Room scroll containment

The room screen must fit the viewport. Long message history must scroll inside
the conversation while navigation, the room heading and participation controls
remain in place. Long room directories scroll independently. Other views scroll
inside the content column, keeping the application navigation in place.

The room-specific shell uses a bounded dynamic viewport height and allows its
grid and flex children to shrink. Desktop displays the directory and conversation
side by side; tablet and mobile allocate separate rows within the same workspace.
Exceptionally long room descriptions have their own bounded header overflow.

Validation: the public showcase e2e suite checks 40 long messages at 1440, 768,
390 and 320 pixel viewport widths. It verifies document dimensions, actual message
scrolling, unchanged navigation/header positions, and visible participation text.
Web build and component tests also pass.
