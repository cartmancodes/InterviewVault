# Shared dark mode

Approved design: extend the portfolio's navy palette to every generated page, including Vault, articles, progress, and the landing page. One accessible Light/Dark button uses a shared saved preference. First visits follow the system preference; an existing portfolio preference is preserved. Theme initialization runs before styles to prevent flashes. Storage failures do not disable the toggle; system changes apply until an explicit choice is made.

Theme text, reading surfaces, navigation, tables, code blocks, search, practice controls, progress, and figure controls. Preserve diagram semantic colors on a neutral light canvas. Retain the current light palette and yellow accents with dark text. Mobile headers must accommodate the toggle without overflow.

Verification: browser tests for both system themes, persistence across routes and reloads, legacy preference, storage failure, and mobile layout; existing tests, site build and link checks; visual review of localhost pages. Leave all changes uncommitted until the user has reviewed the localhost preview.
