"use client";
import styles from "./PatronsSection.module.css";

interface PatronPerson {
  type: "person";
  name: string;
  role: string;
  photo: string;
  imgPosition?: string;
  link?: string;
}

// ── Patrons: President and Vice President ────────────────────────
const PATRONS: PatronPerson[] = [
  {
    type: "person",
    name: "Dr. A. J. Shetty",
    role: "President",
    photo: "/patrons/president.webp",
  },
  {
    type: "person",
    name: "Mr. Prashanth Shetty",
    role: "Vice President",
    photo: "/patrons/vicepresident.webp",
  },
];

function PersonCard({ patron }: { patron: PatronPerson }) {
  const cardContent = (
    <>
      <div className={styles.photoWrap}>
        {patron.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={patron.photo}
            alt={patron.name}
            className={styles.photo}
            style={{ objectPosition: patron.imgPosition ?? "center top" }}
          />
        ) : (
          <div className={styles.photoPlaceholder}>
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>Upload Photo</span>
          </div>
        )}
      </div>
      <span className={styles.pName}>{patron.name}</span>
      <span className={styles.pRole}>{patron.role}</span>
    </>
  );

  if (patron.link) {
    return (
      <a
        href={patron.link}
        target="_blank"
        rel="noopener noreferrer"
        className={`${styles.card} ${styles.personCard}`}
        aria-label={patron.name}
      >
        {cardContent}
      </a>
    );
  }

  return (
    <div
      className={`${styles.card} ${styles.personCard}`}
      aria-label={patron.name}
    >
      {cardContent}
    </div>
  );
}

export default function PatronsSection() {
  return (
    <section id="patrons" className={styles.section}>
      <div className="section">
        <div className={styles.header}>
          <div className="section-label">{"//"} community supporters</div>
          <h2 className="section-title">
            OUR <span className="text-lime">PATRONS</span>
          </h2>
          <p className="section-sub">
            The Hackathon is organised under the esteemed patronage of our institution’s distinguished leaders, whose unwavering support, guidance, and commitment provide the foundation for this initiative. Their strategic direction and generous financial support enable us to create an enriching platform that brings together innovation, technology, and problem-solving. Their encouragement and confidence in the potential of this initiative inspire us to continually raise the standards of excellence and foster an environment where ideas can evolve into meaningful and impactful solutions.
          </p>
        </div>

        <div className={styles.tier}>
          <div className={`${styles.tierGrid} ${styles.gridPatrons}`}>
            {PATRONS.map((p, i) => (
              <PersonCard key={`patron-${i}`} patron={p} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
