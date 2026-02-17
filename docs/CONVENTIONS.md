# Conventions

Terms used in the data and the app.

| Term | Meaning |
|------|--------|
| **People allocated (per project)** | Number of people on that project. **= 1**: only one person; adding more people won’t help (no parallelization within the project). **> 1**: the team has chosen to parallelize within the project (multiple people on it). |
| **Max parallelization** | More people → shorter calendar time, up to the point work can’t be split. Not all projects can be fully parallelized. |
| **60% capacity** | Only 60% of a person’s time is counted for this planning; the rest is other work. |
| **3 devs : 1 QA** | One QA per three developers. Reflected in the source CSV’s “Total resources required”. |
| **Sizing “up to”** | Each band (XS, S, M, L, XL, XXL, 3L, 4L) means the project will take **up to** that many months. |

Bar **length** = duration (months). Bar **thickness** = people allocated (1 = no parallelization, &gt;1 = parallelization chosen).
