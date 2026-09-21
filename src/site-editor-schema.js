// Centralized field registry ("page schema") for the visual website editor.
// Every editable public-site field must be declared here — the API rejects any
// page key or field key that isn't listed in this file. This is the single
// source of truth consumed by:
//   - src/worker-site-editor.js (server-side validation + the schema API response)
//   - admin/public/site-editor.js (renders the correct control per field.type)
//
// To add a new field: add an entry under the page's `fields` map, then add a
// matching `data-cms-field="<page>.<fieldKey>" data-cms-type="<type>"` element to
// the corresponding public HTML page. See SITE_EDITOR.md for the full guide.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const FIELD_TYPES = [
  'weekday', 'time', 'text', 'textarea', 'email', 'telephone', 'url',
  'image', 'boolean', 'select', 'rich_text', 'collection', 'number'
];

// Tags/attributes allowed through the (minimal, regex-based) rich_text sanitizer.
export const RICH_TEXT_ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'br', 'p', 'a'];
export const RICH_TEXT_ALLOWED_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];
export const URL_FIELD_ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

const profileItemFields = {
  name: { type: 'text', label: 'Name', required: true, maxLength: 120 },
  title: { type: 'text', label: 'Title / role', maxLength: 160 },
  bio: { type: 'textarea', label: 'Biography', maxLength: 4000 },
  image: { type: 'image', label: 'Photo' }
};

// Shared shape for both weekly-schedule collections on the Home page. Each item is one
// activity (one weekday + one time + a name + optional details), so two activities that
// share the same day and/or time are simply two separate items — never merged.
const scheduleItemFields = {
  day: { type: 'weekday', label: 'Day', required: true },
  time: { type: 'time', label: 'Time', required: true },
  title: { type: 'text', label: 'Activity name', required: true, maxLength: 120 },
  details: { type: 'textarea', label: 'Details (optional)', maxLength: 400 },
  sortOrder: { type: 'number', label: 'Sort order', min: 0, max: 999 }
};

export const PAGE_SCHEMAS = {
  home: {
    label: 'Home',
    fields: {
      'hero.cta.text': { type: 'text', label: 'Hero button text', required: true, maxLength: 60 },
      'hero.cta.url': { type: 'url', label: 'Hero button link', required: true },
      'sections.worship.heading': { type: 'text', label: 'Worship Times heading', required: true, maxLength: 80 },
      'sections.ministries.heading': { type: 'text', label: 'Weekly Ministry Times heading', required: true, maxLength: 80 },
      'worship.schedule': {
        type: 'collection', label: 'Worship schedule', itemLabel: 'Service', maxItems: 30, itemFields: scheduleItemFields
      },
      'ministries.weeklySchedule': {
        type: 'collection', label: 'Weekly ministry schedule', itemLabel: 'Activity', maxItems: 30, itemFields: scheduleItemFields
      }
    }
  },
  ministries: {
    label: 'Ministries',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.intro': { type: 'rich_text', label: 'Intro text', maxLength: 2000 },
      profiles: {
        type: 'collection', label: 'Ministry leaders', itemLabel: 'Leader', maxItems: 40, itemFields: profileItemFields
      }
    }
  },
  associate_ministers: {
    label: 'Associate Ministers',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      profiles: {
        type: 'collection', label: 'Associate ministers', itemLabel: 'Minister', maxItems: 20, itemFields: profileItemFields
      }
    }
  },
  leadership: {
    label: 'Leadership & Staff',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'sections.staff.heading': { type: 'text', label: 'Staff section heading', required: true, maxLength: 80 },
      'sections.deacons.heading': { type: 'text', label: 'Deacons section heading', required: true, maxLength: 80 },
      'sections.deacons.intro': { type: 'rich_text', label: 'Deacons intro text', maxLength: 2000 },
      'sections.deaconesses.heading': { type: 'text', label: 'Deaconesses section heading', required: true, maxLength: 80 },
      'sections.official_team.heading': { type: 'text', label: 'Official Team & Trustees section heading', required: true, maxLength: 80 },
      profiles: {
        type: 'collection',
        label: 'Leadership profiles',
        itemLabel: 'Profile',
        maxItems: 60,
        groups: ['staff', 'deacons', 'deaconesses', 'official_team'],
        itemFields: profileItemFields
      }
    }
  },
  church_history: {
    label: 'Church History',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      hero_image: { type: 'image', label: 'History page photo' }
    }
  },
  facility_rental: {
    label: 'Facility Rental',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'sections.rental.heading1': { type: 'text', label: 'First section heading', required: true, maxLength: 80 },
      'sections.rental.description': { type: 'rich_text', label: 'Sacred Celebrations description', maxLength: 2000 },
      'sections.rental.heading2': { type: 'text', label: 'Second section heading', required: true, maxLength: 80 },
      'contact.email': { type: 'email', label: 'Rental contact email', required: true },
      'contact.phone': { type: 'telephone', label: 'Rental contact phone', required: true },
      availability: {
        type: 'select',
        label: 'Availability status',
        required: true,
        options: [
          { value: 'open', label: 'Open for booking' },
          { value: 'limited', label: 'Limited availability' },
          { value: 'closed', label: 'Not currently available' }
        ]
      }
    }
  },
  live_praise: {
    label: 'Live Praise',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.description': { type: 'rich_text', label: 'Intro description', maxLength: 1000 },
      currently_live: { type: 'boolean', label: 'Show "We are currently LIVE" banner' },
      'stream.url': { type: 'url', label: 'Livestream embed URL', required: true }
    }
  },
  contact: {
    label: 'Contact',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.intro': { type: 'rich_text', label: 'Intro text', maxLength: 500 },
      'sections.form.intro': { type: 'rich_text', label: 'Form section intro text', maxLength: 500 },
      'contact.address': { type: 'textarea', label: 'Address', required: true, maxLength: 300 },
      'contact.phone': { type: 'telephone', label: 'Phone', required: true },
      'contact.email': { type: 'email', label: 'Email', required: true },
      'contact.fax': { type: 'telephone', label: 'Fax' }
    }
  }
};

export const PAGE_KEYS = Object.keys(PAGE_SCHEMAS);

// Initial published values — MUST mirror the current live static HTML exactly so the
// first migration (first time a page row is created) does not change public appearance.
// This migration is idempotent: src/worker-site-editor.js only inserts this seed data
// when a page has no existing row; it never overwrites a value that's already stored.
export const INITIAL_PUBLISHED_CONTENT = {
  home: {
    'hero.cta.text': 'Contact Us',
    'hero.cta.url': '/Pages/contact.html#contact-form-section',
    'sections.worship.heading': 'Worship Times',
    'sections.ministries.heading': 'Weekly Ministry Times',
    'worship.schedule': [
      { id: 'sun-0930-discipleship', day: 'Sunday', time: '09:30', title: 'Discipleship Training', details: 'Youth & Adult', sortOrder: 0 },
      { id: 'sun-1100-worship', day: 'Sunday', time: '11:00', title: 'Morning Worship', details: '', sortOrder: 1 },
      { id: 'mon-1800-prayer', day: 'Monday', time: '18:00', title: 'Prayer Meeting', details: '', sortOrder: 2 },
      { id: 'wed-1830-bible-study', day: 'Wednesday', time: '18:30', title: 'Bible Study', details: '', sortOrder: 3 }
    ],
    'ministries.weeklySchedule': [
      { id: 'tue-1800-womens-ministry', day: 'Tuesday', time: '18:00', title: 'Womens Ministry', details: 'Every 4th Tuesday', sortOrder: 0 },
      { id: 'wed-1730-youth-choir', day: 'Wednesday', time: '17:30', title: 'Youth Choir Rehearsal', details: 'Every Wednesday before 3rd Sunday', sortOrder: 1 },
      { id: 'wed-1730-ushers-meeting', day: 'Wednesday', time: '17:30', title: "Usher's Meeting", details: 'Last Wednesday of the Month: Mar, Jun, Sept, Dec', sortOrder: 2 },
      { id: 'thu-1800-mass-choir', day: 'Thursday', time: '18:00', title: 'Mass Choir Rehearsal', details: 'Thursday before 1st & 5th Sunday', sortOrder: 3 },
      { id: 'thu-1800-womens-choir', day: 'Thursday', time: '18:00', title: "Women's Choir Rehearsal", details: 'Thursday before 2nd Sunday', sortOrder: 4 },
      { id: 'thu-1830-male-choir', day: 'Thursday', time: '18:30', title: 'Male Choir Rehearsal', details: 'Thursday before 4th & 5th Sunday', sortOrder: 5 }
    ]
  },
  ministries: {
    'page.title': 'Ministries',
    'page.intro': 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.',
    // These values mirror the existing static ministry cards. They provide a safe
    // first-run seed for the D1-backed editor while keeping the public page
    // unchanged until an administrator publishes a change.
    profiles: [
      {
        id: 'ministries-1',
        name: 'Evangelist Melanie Nunn',
        title: '',
        bio: 'Before moving to Paducah, she and her family lived in Detroit, MI for twenty-five years where she taught English and Journalism at Henry Ford High School.\n\nEvangelist Nunn responded to God’s call in 2000 and has never looked back. She is an associate minister at Mount Moriah Missionary Baptist Church in Paducah, KY where she also served as Superintendent of Disciples in Training (formerly known as Sunday school). She considers it an honor to be both licensed and ordained by her father in the ministry and pastor, Reverend Dr. Calvin Cole, Sr.',
        image: { url: '../ConImg/webPages/ministries_image1.png', alt: 'Evangelist Melanie Nunn' }
      },
      {
        id: 'ministries-2',
        name: 'Elder Jimmy Jones',
        title: '',
        bio: 'Elder Jones was born in Cairo IL, graduate of Sumner High School, West KY Vocational-Technical School and attended Coyne Electronic Institute for 15 months. He was an employee of USEC for 37 years in instrument maintenance.\n\nHe was married to Teressia Jones for 38 years and from this union they have 4 children.\n\nElder Jones was ordained February 18, 1996, at Higher Dimensions Church, Paducah Ky by Rev. Zachery Strong.',
        image: { url: '../ConImg/webPages/ministries_image2.jpeg', alt: 'Elder Jimmy Jones' }
      },
      {
        id: 'ministries-3',
        name: 'Rev. Fairly Taylor',
        title: '',
        bio: 'Reverend Fairley Taylor Jr, is the son of Brenda Taylor and the late Fairley Taylor Sr.\n\nReverend Taylor grew up in Hopkinsville KY. He received his commission in 1988 as a U S Army Officer.\n\nIn 1989 he graduated from Murray State University with a Bachelor of Science degree in Animal Science.\n\nHe was ordinated as a deacon in 1991. He served several years on the finance committee, church clerk, youth leader and chairman of the van ministry. He was called into the ministry in 2005, and his initial sermon was “Why Do We Doubt God”, 1 Kings 19:1-5.\n\nHe received his licensed to preach January 4, 2007, from Reverend Dr. W.G. Harvey Sr. at New Greater Love Missionary Baptist Church, Paducah KY',
        image: { url: '../ConImg/webPages/ministries_image3.png', alt: 'Rev. Fairly Taylor' }
      },
      {
        id: 'ministries-4',
        name: 'Minister Joyce Shields',
        title: '',
        bio: 'Joyce Marie Harden-Shields is second oldest of five children born to the parents Leon (deceased) and Joyce Harden.\n\nA 1978 graduate of Eudora High School, Eudora Arkansas; completed Personal Care Training at Central Arkansas Area Agency on Aging in 1985; graduated in 1993 from Great Rivers Vocational School in McGee Arkansas with a business secretary degree.\n\nAt fourteen she accepted Jesus Christ as her Lord and Savior and was baptized under the leadership of the late Rev. Edgar Handie, Zion Chapel Baptist Church.\n\nWhile in Eudora formed a gospel group The Wings of Joy under the direction of musician Antionetta Harden.\n\nNovember 1996, she and her two sons Maurice and LaMarcus moved to Paducah KY.\n\nIn 1997 joined White Oak Missionary Baptist Church, Rev. Calvin R. Cole, Sr. Pastor.\n\nFebruary 10, 2001, she married Jesse Shields Jr. This union brought a family of three to a family of six Maurice, LaMarcus, Jonathan and Vahon with 6 children.\n\nOn April 15, 2001, her membership was moved to Mt. Moriah Missionary Baptist Church under the leadership of Rev. Calvin R. Cole, Sr.\n\nMarch 31, 2019, received and accepted the call into the ministry.\n\nPast offices: president of the Missionary Circle, Discipleship Training Superintendent and Women’s Ministry secretary.\n\nOne of her many favorite scriptures 2nd Chronicles 7:14 “If my people who are called by my name will humble themselves and pray and seek my face and turn from their wicked ways, then I will hear from heaven, and I will forgive their sins and will heal their land”.\n\nI owe it ALL to the Lord….if it had not been for the Lord on my side who kept me safe even when I couldn’t see it…. where would I be. All my help comes from the Lord.',
        image: { url: '../ConImg/webPages/ministries_image4.jpeg', alt: 'Minister Joyce Shields' }
      },
      {
        id: 'ministries-5',
        name: 'Minister Doralyn Warren',
        title: '',
        bio: 'Currently employed at West Kentucky Community and Technical College as an Instructor of teaching in the Nursing Assistant Program. Her previous employment was working in Longterm Care for over 40 years. Her passion for taking care of the elderly community she says “is a calling”. Now she is teaching nursing assistants to give the best care and service to the elders. She has a strong passion for teaching which she sees is a gift from God. The purpose of her call into the ministry is to teach God’s love to all people without a respect of persons.\n\nEducation Bachelor of Science Nursing (BSN) from Wesleyan University in 2010 Now attending Newburgh Seminary to receive a Master of Ministry degree.\n\nProfessional Skills Doralyn Warren, LLC Consultant Answer questions from family members in regard to longterm care placement or at home assistance. Allowing family’s to express their concerns of becoming a caregiver.\n\nPersonal Hobbies Riding her bike, walking, cooking and reading Studying the Old Testament is her favorite lessons in the Bible.\n\nPersonal Philosophy “Life is a gift, you decide how you open it”. Proverbs 23:7a NKJV “For as he thinks in his heart, so is he.\n\nFamily She is the parent of Kimberly D. Warren and H. Jermaine Warren of Louisville, Kentucky. One favorite granddaughter, Jordayn and two grandsons, Justin and Josh.',
        image: { url: '../ConImg/webPages/ministries_image5.png', alt: 'Minister Doralyn Warren' }
      },
      {
        id: 'ministries-6',
        name: 'Rev. Dennis Gray',
        title: '',
        bio: 'Pastor Dennis Gray, a native of Hickman, Kentucky, is a commissioned minister of the Christian Church (Disciple of Christ). Pastor Gray was called by God to the ministry in January 1997; he answered the call and made the petition to God that if He would fill him with the Holy Spirit, he would go wherever he was sent.\n\nPastor Gray served as the pastor of Second Christian Church in Mayfield, KY for 23 years, where he shepherded the congregation into transformation. His portfolio includes Overseas Ministry in Haiti, Heaven on Earth conference in Indianapolis, attended Lexington Theological seminary where he did special study classes and program activities such as Disciples History, Survey of Christian Thought, Introduction to Pastoral Care, Preaching, Evangelism, and Church Leadership, Minister and Pastor’s Leadership, Temple Hill MD.\n\nPastor Gray has retired from Pastoring at Second Christian Church and is now serving at Mt. Moriah Missionary Baptist Church in Paducah, Kentucky as an Associate Minister. Pastor Gray is the husband of Sue Gray, and together they have three children and four grandchildren.\n\nPastor Gray is very serious about the work of the Lord. He is an inspirational and gifted teacher-preacher with exceptional leadership and team-building skills.',
        image: { url: '../ConImg/webPages/ministries_image6.jpeg', alt: 'Rev. Dennis Gray' }
      }
    ]
  },
  leadership: {
    'page.title': 'Leadership & Staff',
    'sections.staff.heading': 'Staff',
    'sections.deacons.heading': 'Deacons',
    'sections.deacons.intro': '<p>The deacons are ordained to do their work according to Acts 6:1-8, 1 Timothy 3:8-13 and Titus 2.</p><p>The deacons assist the pastor, cooperate with the pastor in providing the pulpit supply and the leaders of the prayer meeting; visit members; care for the sick and needy and distressed members of the church. The board shall promote Christian instruction and ministry to the church membership.</p>',
    'sections.deaconesses.heading': 'Deaconesses',
    'sections.official_team.heading': 'Official Team & Trustees',
    profiles: []
  },
  church_history: {
    'page.title': 'CHURCH HISTORY',
    hero_image: { url: '/ConImg/webPages/church_history_image1.jpeg', alt: 'Mt. Moriah Missionary Baptist Church historical photo' }
  },
  facility_rental: {
    'page.title': 'Facility Rental',
    'sections.rental.heading1': 'Sacred Celebrations',
    'sections.rental.description': '<p>Your wedding or other special event must be a sacred celebration. Your plans for the service should reflect that fact and also align with the beliefs and worship practices of Mt. Moriah Missionary Baptist Church. Careful planning will ensure that your wedding is meaningful to you, your family, and friends.</p><p>Mt. Moriah Missionary Baptist Church seats up to 250 people, and the fellowship and educational building seating is 200.</p>',
    'sections.rental.heading2': 'Submit a Request for Building Rental',
    'contact.email': 'mtmoriahmbc@comcast.net',
    'contact.phone': '(270) 443-3714',
    availability: 'open'
  },
  live_praise: {
    'page.title': 'Live Praise',
    'page.description': '<p>When our services are being broadcast LIVE, the current service will be shown at the top of the page.</p><p>Otherwise, the most recent service will appear at the top.</p><p>Other past services are shown below the first image in chronological order.</p>',
    currently_live: false,
    'stream.url': 'https://www.youtube.com/embed/live_stream?channel=UCkAaHiYmUKIdKePifg1D2pg&rel=0'
  },
  contact: {
    'page.title': 'Contact Us',
    'page.intro': 'Have questions? Need more information about our church or an upcoming event? Please feel free to reach out to us!',
    'sections.form.intro': 'We value your connection. Use the form below to send us a message.',
    'contact.address': '1201 S 8th St, Paducah, KY 42003',
    'contact.phone': '(270) 443-3714',
    'contact.email': 'mtmoriahmbc1201@gmail.com',
    'contact.fax': '(270) 443-7125'
  }
};

// The public page assignments were corrected after an earlier migration swapped
// the associate-minister and ministry profile collections. Keep the canonical
// values here so new D1 rows and legacy migration rows use the corrected pages.
INITIAL_PUBLISHED_CONTENT.ministries.profiles = [
  {
    id: 'ministries-1', name: 'Music Department', title: 'Elaine Fletcher, Pianist',
    bio: 'The music department is responsible for music at morning service, midweek, the Lord’s Supper, Discipleship Training, and all evening and outside programs designated. The Music Department includes the Mass Choir, Women’s Choir, Youth Choir, and Male Chorus.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2025/05/Elaine.jpeg', alt: 'Elaine Fletcher' }
  },
  {
    id: 'ministries-2', name: 'Women’s Ministry', title: 'Earlie Fugate, President',
    bio: 'Our focus is to be a ministry where women are encouraged and enriched by studying and applying God’s Word.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2025/05/Earlie.jpeg', alt: 'Earlie Fugate' }
  },
  {
    id: 'ministries-3', name: 'Usher Board', title: 'Richard Washington, President',
    bio: 'The ushers shall attend to the seating of the congregation and to such other duties as may be directed.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Richard-Washington.png', alt: 'Richard Washington' }
  },
  {
    id: 'ministries-4', name: 'Culinary Department', title: 'Brenda Stokes, Department Head',
    bio: 'It shall be the duty of this committee to organize feeding functions of the church.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Brenda-Stokes.png', alt: 'Brenda Stokes' }
  },
  {
    id: 'ministries-5', name: 'First Aid Care Committee', title: 'Tawanda Maxwell, President',
    bio: 'Render services needed to the congregation.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Image-Coming-Soon.png', alt: 'First Aid Care Committee' }
  },
  {
    id: 'ministries-6', name: 'Discipleship Training', title: 'Minister Doralyn Warren & William Stanley Jones, Superintendents',
    bio: 'Shall be responsible for training and teaching the membership how to become more like Christ.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/disciple-training.png', alt: 'Discipleship Training' }
  },
  {
    id: 'ministries-7', name: 'Transportation Committee', title: 'Jesse Shields, Department Head',
    bio: 'It shall be the responsibility of this committee to provide transportation for church services and activities. A schedule of drivers will be prepared, and drivers must possess a valid driver’s license.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/Jesse-Shields.jpg', alt: 'Jesse Shields' }
  },
  {
    id: 'ministries-8', name: 'Youth Department', title: 'Tonya Gill, Department Head',
    bio: 'To assist boys and girls, ages 5 and up, in the stages of transition to becoming healthy and strong Christian men and women.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Tonya-Gill.png', alt: 'Tonya Gill' }
  },
  {
    id: 'ministries-9', name: 'Decorations', title: 'Janice Jones, Department Head',
    bio: 'It shall be the responsibility of this committee to decorate the sanctuary with seasonal decorations or decorations to present a particular theme. This committee is also responsible for decorations for special events.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/Janice-Jones.jpg', alt: 'Janice Jones' }
  },
  {
    id: 'ministries-10', name: 'Custodial', title: 'Uvette Kizer & Margaret Faulkner',
    bio: 'It shall be the responsibility of this committee to provide for the maintenance and upkeep of buildings.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/Custodial.png', alt: 'Custodial Ministry' }
  },
  {
    id: 'ministries-11', name: 'Lawn Keeper', title: 'Derek Strong, Department Head',
    bio: 'It shall be the responsibility of this committee to provide for the maintenance and upkeep of buildings and grounds. This shall consist of exterior and interior.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Derek-Strong.png', alt: 'Derek Strong' }
  },
  {
    id: 'ministries-12', name: 'Courtesy / Hospitality', title: 'Mary Dumas, Department Head',
    bio: 'It shall be the duty of this committee to welcome visitors to church services, membership to church services, and visiting churches.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/Mary-Dumas.jpg', alt: 'Mary Dumas' }
  },
  {
    id: 'ministries-13', name: 'Photographer', title: 'Elbert Speers',
    bio: 'It shall be the duty of the committee to gather and maintain any and all pictures that will contribute to the cumulative history of the church.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/10/Elbert-Speers.png', alt: 'Elbert Speers' }
  },
  {
    id: 'ministries-14', name: 'Video / Audio Ministry', title: 'Calvin Cole, Jr., Elbert Spears, Derek Strong',
    bio: 'One who controls the sound/volume. Also, one who records the services for those who desire a copy or cannot attend service in person.',
    image: { url: 'https://mmmbc.com/wp-content/uploads/2024/11/Video.png', alt: 'Video / Audio Ministry' }
  }
];

INITIAL_PUBLISHED_CONTENT.leadership.profiles = [
  {
    id: 'leadership-1', group: 'staff', name: 'Rev. Stephen Harvey', title: 'Pastor',
    bio: 'Stephen Harvey, a native of Paducah, Kentucky, received his Bachelor of Social Work and minor in Physical Education from Murray State University and is pursuing a Master’s in Human Development and Leadership. He was licensed to preach in 2005, ordained in 2011, and has served as an associate minister, youth director, teacher, treasurer, and pastor. He is retired from the Mayfield Youth Development Center and continues to give God all the praise, honor, and glory for the opportunity to be His humble servant.',
    image: { url: '../ConImg/SteveHarvey1.png', alt: 'Rev. Stephen Harvey' }
  },
  {
    id: 'leadership-2', group: 'staff', name: 'Marsha Roundtree', title: 'Church Administrative Assistant',
    bio: 'Keeps complete records of the transactions of all business meetings; keeps records of church membership and baptism; prepares bulletins and correspondence; sends annual giving statements to members; and serves as finance secretary in assisting the finance chairman.',
    image: { url: '../ConImg/webPages/leadership_staff_image1.jpeg', alt: 'Marsha Roundtree' }
  },
  {
    id: 'leadership-3', group: 'staff', name: 'Weldon Stokes', title: 'Finance Chairman',
    bio: 'The Finance Chairman is responsible for the financial records of the church. Weldon Stokes has served as a deacon for over 30 years and is a member of the Usher Ministry, Culinary Ministry, and Official Team.',
    image: { url: '../ConImg/webPages/leadership_staff_image2.png', alt: 'Weldon Stokes' }
  },
  {
    id: 'leadership-4', group: 'staff', name: 'John Burnett', title: 'Finance Vice Chair',
    bio: 'The Finance Vice Chairman supports the finance chairman and is responsible for financial records when the chairman is not available. John Burnett has served as a deacon for over 20 years and is active in the Ushers Ministry, Culinary Ministry, and Official Team.',
    image: { url: '../ConImg/webPages/leadership_staff_image3.jpeg', alt: 'John Burnett' }
  }
];

INITIAL_PUBLISHED_CONTENT.associate_ministers = {
  'page.title': 'Associate Ministers',
  profiles: [
    {
      id: 'associate-ministers-1', name: 'Evangelist Melanie Nunn', title: '',
      bio: 'Before moving to Paducah, she and her family lived in Detroit, MI for twenty-five years where she taught English and Journalism at Henry Ford High School. Evangelist Nunn responded to God’s call in 2000 and has never looked back. She is an associate minister at Mount Moriah Missionary Baptist Church in Paducah, KY where she also served as Superintendent of Disciples in Training. She considers it an honor to be both licensed and ordained by her father in the ministry and pastor, Reverend Dr. Calvin Cole, Sr.',
      image: { url: '../ConImg/webPages/ministries_image1.png', alt: 'Evangelist Melanie Nunn' }
    },
    {
      id: 'associate-ministers-2', name: 'Elder Jimmy Jones', title: '',
      bio: 'Elder Jones was born in Cairo IL, graduated from Sumner High School and West KY Vocational-Technical School, and attended Coyne Electronic Institute for 15 months. He was an employee of USEC for 37 years in instrument maintenance. He was married to Teressia Jones for 38 years and from this union they have four children. Elder Jones was ordained February 18, 1996, at Higher Dimensions Church, Paducah, KY by Rev. Zachery Strong.',
      image: { url: '../ConImg/webPages/ministries_image2.jpeg', alt: 'Elder Jimmy Jones' }
    },
    {
      id: 'associate-ministers-3', name: 'Rev. Fairly Taylor', title: '',
      bio: 'Reverend Fairley Taylor Jr. is the son of Brenda Taylor and the late Fairley Taylor Sr. He grew up in Hopkinsville, KY, received his commission in 1988 as a U.S. Army officer, and graduated from Murray State University in 1989 with a Bachelor of Science degree in Animal Science. He was ordained as a deacon in 1991, called into ministry in 2005, and received his license to preach January 4, 2007 from Reverend Dr. W.G. Harvey Sr. at New Greater Love Missionary Baptist Church in Paducah, KY.',
      image: { url: '../ConImg/webPages/ministries_image3.png', alt: 'Rev. Fairly Taylor' }
    },
    {
      id: 'associate-ministers-4', name: 'Minister Joyce Shields', title: '',
      bio: 'Joyce Marie Harden-Shields is the second oldest of five children born to Leon (deceased) and Joyce Harden. She accepted Jesus Christ as her Lord and Savior at fourteen, moved to Paducah in 1996, joined White Oak Missionary Baptist Church in 1997, and moved her membership to Mt. Moriah in 2001. She accepted the call into ministry on March 31, 2019 and has served as president of the Missionary Circle, Discipleship Training Superintendent, and Women’s Ministry secretary.',
      image: { url: '../ConImg/webPages/ministries_image4.jpeg', alt: 'Minister Joyce Shields' }
    },
    {
      id: 'associate-ministers-5', name: 'Minister Doralyn Warren', title: '',
      bio: 'Doralyn Warren is an instructor in the Nursing Assistant Program at West Kentucky Community and Technical College. She previously worked in long-term care for over 40 years and sees caring for the elderly as a calling. She earned a Bachelor of Science in Nursing from Wesleyan University in 2010 and is attending Newburgh Seminary for a Master of Ministry degree.',
      image: { url: '../ConImg/webPages/ministries_image5.png', alt: 'Minister Doralyn Warren' }
    },
    {
      id: 'associate-ministers-6', name: 'Rev. Dennis Gray', title: '',
      bio: 'Pastor Dennis Gray, a native of Hickman, Kentucky, is a commissioned minister of the Christian Church (Disciple of Christ). He served as pastor of Second Christian Church in Mayfield, KY for 23 years and now serves Mt. Moriah Missionary Baptist Church in Paducah, Kentucky as an Associate Minister. Pastor Gray is the husband of Sue Gray, and they have three children and four grandchildren.',
      image: { url: '../ConImg/webPages/ministries_image6.jpeg', alt: 'Rev. Dennis Gray' }
    }
  ]
};

export function getPageSchema(page) {
  return PAGE_SCHEMAS[String(page || '').trim().toLowerCase()] || null;
}

export function getFieldSchema(page, fieldKey) {
  const schema = getPageSchema(page);
  if (!schema) return null;
  return schema.fields[fieldKey] || null;
}
