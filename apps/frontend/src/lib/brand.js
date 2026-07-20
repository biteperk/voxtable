/**
 * Single source of truth for public brand contact details.
 *
 * Before this file the phone number was hard-coded per component and had
 * drifted into three different numbers across the product (marketing,
 * booking modal, error screen). Import from here so a number change is a
 * one-line edit and can never fragment again.
 *
 * PHONE_DISPLAY is the local Australian format shown to visitors;
 * PHONE_HREF is the international form required for `tel:` to dial.
 * Keep these in sync with biteperk.com.au.
 */
export const PHONE_DISPLAY = "02 5504 1140";
export const PHONE_HREF = "tel:+61255041140";
export const EMAIL = "hello@biteperk.com.au";
export const EMAIL_HREF = "mailto:hello@biteperk.com.au";

/**
 * Parent-brand (biteperk.com.au) URLs for cross-linking back to the
 * marketing site. Use exact canonical forms (trailing slash on content
 * pages) so links resolve 200 with no 301 hop. VocoTable is a product of
 * BitePerk; these tie the app to the brand for visitors and for SEO.
 */
export const SITE_URL = "https://biteperk.com.au";
export const PRODUCT_URL = "https://biteperk.com.au/products/vocotable/";
export const GUIDES_URL = "https://biteperk.com.au/blog/";
export const ABOUT_URL = "https://biteperk.com.au/about/";
export const CONTACT_URL = "https://biteperk.com.au/contact/";
export const PRIVACY_URL = "https://biteperk.com.au/legal/privacy/";
export const TERMS_URL = "https://biteperk.com.au/legal/terms/";
