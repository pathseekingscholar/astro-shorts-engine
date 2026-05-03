const FACT_BANK = [
  {
    id: "asteroid",
    keywords: ["asteroid", "bennu", "osiris", "osiris-rex", "sample", "return", "capsule", "regolith"],
    facts: [
      {
        text: "OSIRIS-REx returned NASA's first asteroid sample to Earth from Bennu on September 24, 2023.",
        source: "https://science.nasa.gov/missions/osiris-rex/osirisrex-delivers-nasas-first-asteroid-sample-to-earth/"
      },
      {
        text: "Asteroid samples matter because they preserve material from the early solar system.",
        source: "https://science.nasa.gov/mission/osiris-rex/"
      }
    ],
    replyTemplates: [
      "This mission matters because Bennu material is a physical sample, not just a telescope observation.",
      "Sample-return footage is powerful because the science continues after landing, once the material reaches the lab."
    ]
  },
  {
    id: "iss",
    keywords: ["iss", "space station", "astronaut", "orbit", "microgravity"],
    facts: [
      {
        text: "The International Space Station circles Earth at roughly 17,500 mph.",
        source: "https://www.nasa.gov/international-space-station/space-station-facts-and-figures/"
      },
      {
        text: "A full orbit takes about 90 minutes, so crews see around 16 sunrises each day.",
        source: "https://www.nasa.gov/international-space-station/space-station-facts-and-figures/"
      }
    ],
    replyTemplates: [
      "This footage is from real orbital operations, and the ISS is moving at about 17,500 mph while doing it.",
      "What makes it look unreal is the speed plus microgravity. The station laps Earth every 90 minutes."
    ]
  },
  {
    id: "sun",
    keywords: ["sun", "solar", "flare", "heliophysics", "stereo", "sdo", "soho", "corona"],
    facts: [
      {
        text: "A solar flare is an intense burst of radiation released when magnetic energy near sunspots erupts.",
        source: "https://science.nasa.gov/sun/solar-storms-and-flares/"
      },
      {
        text: "Solar observatories like SDO, SOHO, and STEREO watch active regions from different viewpoints.",
        source: "https://science.nasa.gov/sun/solar-storms-and-flares/"
      }
    ],
    replyTemplates: [
      "The bright flash is not fire in the normal sense; it is radiation from magnetic energy erupting in the Sun's atmosphere.",
      "Solar footage gets weird because spacecraft are often viewing the Sun in wavelengths our eyes cannot normally see."
    ]
  },
  {
    id: "moon",
    keywords: ["moon", "lunar", "apollo", "artemis"],
    facts: [
      {
        text: "The Moon is about 238,855 miles from Earth on average.",
        source: "https://science.nasa.gov/moon/facts/"
      },
      {
        text: "Apollo footage still matters because lunar dust, lighting, and motion are hard to fake convincingly.",
        source: "https://science.nasa.gov/moon/"
      }
    ],
    replyTemplates: [
      "The Moon's average distance is about 238,855 miles, which is why even familiar footage still feels enormous.",
      "Apollo visuals hit because the light behaves differently on the Moon than it does in an atmosphere."
    ]
  },
  {
    id: "jwst",
    keywords: ["webb", "jwst", "infrared", "deep field", "nebula"],
    facts: [
      {
        text: "NASA says Webb operates near the Sun-Earth L2 point, about 1 million miles from Earth.",
        source: "https://science.nasa.gov/mission/webb/orbit/"
      },
      {
        text: "Webb observes the universe primarily in infrared light, which helps it see through dust.",
        source: "https://science.nasa.gov/mission/webb/science-goals/"
      }
    ],
    replyTemplates: [
      "Webb is working around 1 million miles away near L2, which is part of why its temperature control is so critical.",
      "Infrared is the trick here. Webb can see through dust that would block a lot of visible-light detail."
    ]
  },
  {
    id: "hubble",
    keywords: ["hubble", "galaxy", "nebula", "deep space"],
    facts: [
      {
        text: "Hubble orbits above most of Earth's atmosphere, which is why it can capture exceptionally sharp visible-light images.",
        source: "https://science.nasa.gov/mission/hubble/overview/"
      },
      {
        text: "Hubble and Webb are complementary: one is strongest in visible and ultraviolet, the other in infrared.",
        source: "https://science.nasa.gov/mission/hubble/"
      }
    ],
    replyTemplates: [
      "Hubble stays above most atmospheric distortion, which is a big reason the imagery looks so clean.",
      "Hubble and Webb are a strong combo because they do not see the universe in exactly the same way."
    ]
  },
  {
    id: "mars",
    keywords: ["mars", "perseverance", "curiosity", "rover", "jezero"],
    facts: [
      {
        text: "Mars has seasons, polar ice, volcanoes, canyons, and weather, but its atmosphere is far thinner than Earth's.",
        source: "https://science.nasa.gov/mars/facts/"
      },
      {
        text: "Perseverance is exploring Jezero Crater because it once held an ancient river delta.",
        source: "https://science.nasa.gov/mission/mars-2020-perseverance/"
      }
    ],
    replyTemplates: [
      "Mars looks calm in a lot of clips, but the atmosphere is incredibly thin compared with Earth's.",
      "Jezero Crater matters because it preserves evidence of an ancient river-delta environment."
    ]
  },
  {
    id: "rocket",
    keywords: ["rocket", "launch", "engine", "booster", "countdown", "artemis"],
    facts: [
      {
        text: "A launch sequence is a timed handoff between ground systems, engines, guidance software, and range safety before liftoff.",
        source: "https://www.nasa.gov/mission/artemis/"
      },
      {
        text: "Countdown calls, engine events, and holds are real mission steps, not added drama.",
        source: "https://www.nasa.gov/video/"
      }
    ],
    replyTemplates: [
      "The calls you hear in launch footage usually mark real checks across ground systems, vehicle systems, and mission control.",
      "The tension is real because everything is being sequenced before the rocket is allowed to leave the pad."
    ]
  }
];

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function selectFacts(brief, candidates) {
  const haystack = [...tokenize(brief.topic), ...tokenize(brief.angle)];
  for (const candidate of candidates) {
    haystack.push(...tokenize(candidate.title));
    haystack.push(...tokenize(candidate.description));
    haystack.push(...(candidate.keywords || []).flatMap(tokenize));
  }

  const scored = FACT_BANK.map((entry) => {
    const hits = entry.keywords.reduce(
      (count, keyword) => count + (haystack.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    );
    return { entry, hits };
  }).sort((left, right) => right.hits - left.hits);

  const top = scored.find((item) => item.hits > 0)?.entry ?? FACT_BANK[0];
  return {
    topicBucket: top.id,
    facts: top.facts.slice(0, 2),
    replies: top.replyTemplates.slice(0, 2),
    disclosure:
      "Uses NASA source media and public information. Do not imply NASA endorsed the finished video or AI output."
  };
}
