-- Keep public submissions structured so the admin inbox can display and search
-- validated contact details without reparsing a free-form address.
ALTER TABLE contact_messages ADD COLUMN first_name TEXT;
ALTER TABLE contact_messages ADD COLUMN last_name TEXT;
ALTER TABLE contact_messages ADD COLUMN address_line1 TEXT;
ALTER TABLE contact_messages ADD COLUMN address_line2 TEXT;
ALTER TABLE contact_messages ADD COLUMN city TEXT;
ALTER TABLE contact_messages ADD COLUMN state TEXT;
ALTER TABLE contact_messages ADD COLUMN postal_code TEXT;

ALTER TABLE facility_rental_requests ADD COLUMN first_name TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN last_name TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN address TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN address_line1 TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN address_line2 TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN city TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN state TEXT;
ALTER TABLE facility_rental_requests ADD COLUMN postal_code TEXT;
