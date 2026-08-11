import { parsePhoneNumber } from 'libphonenumber-js/min';

/**
 * Validate and normalize phone number to E.164 format
 * @param phone - Phone number to validate (with or without country code)
 * @returns Normalized phone number in E.164 format (e.g., +6285156541910)
 * @throws Error if phone number is invalid
 */
export function validatePhoneNumber(phone: string): string {
  try {
    // Remove any whitespace
    const cleaned = phone.trim();

    // Parse phone number (auto-detect country if international format)
    const phoneNumber = parsePhoneNumber(cleaned, 'ID');

    if (!phoneNumber) {
      throw new Error(`Invalid phone number format: ${phone}`);
    }

    if (!phoneNumber.isValid()) {
      throw new Error(`Phone number is not valid: ${phone}`);
    }

    // Return E.164 format (e.g., +6285156541910)
    return phoneNumber.number.replace('+', '');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Phone validation failed: ${error.message} for: ${phone}`,
      );
    }
    throw new Error(`Phone validation failed for: ${phone}`);
  }
}
