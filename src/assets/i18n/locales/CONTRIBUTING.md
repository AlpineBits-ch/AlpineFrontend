# Contributing to Venta Translations

First off, thank you for considering contributing to **Venta**! It is community members like you that help make Venta accessible to everyone, everywhere.

## Licensing & Legal

Venta is a proprietary messaging application. To ensure we can legally include your contributions in our app while keeping these translation files open-source, we follow an **Inbound=Outbound** policy:

1. **License:** By contributing, you agree that your contributions are licensed under the **MIT License**.
2. **Commercial Use:** You acknowledge that these translations will be pulled into the proprietary Venta codebase for use in our commercial products.
3. **CLA:** All contributors must sign our digital Contributor License Agreement (CLA) via the automated PR bot before a merge can occur.

---

## How to Contribute

### 1. Find your language

Check the `/locales` folder.

- If the file exists (e.g., `de.json`), you can improve existing strings.
- If it doesn't exist, use `en.json` as a template to start a new translation.

### 2. Translation Rules

- **No Machine Translations:** Please do not use Google Translate or DeepL. We want Venta to feel "human" and native.
- **Variables:** Keep variables like `{{count}}` or `{{user}}` exactly as they appear.
- **Context:** If you are unsure of the context of a string, please open an Issue to ask.

### 3. Submission Process

1. Fork the repository.
2. Create a new branch (`git checkout -b lang/spanish`).
3. Commit your changes (`git commit -m "Add Spanish localization"`).
4. Push to the branch and open a Pull Request.
5. **Sign the CLA** when the bot prompts you in the PR comments.

---

## Code of Conduct

Be respectful and helpful. We reserve the right to reject translations that are offensive, inaccurate, or intentionally misleading.

Thank you for helping Venta grow!
