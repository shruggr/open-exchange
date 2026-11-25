// Open Exchange explainer: clickable roles and a step-through swap.
// No build step, no dependencies.

const info = {
  wallet: {
    title: "Your wallet",
    body: "Your wallet holds the sats and tokens. It builds and signs the transaction, and receives the swap payout. The exchange never takes custody, so there is no exchange balance to deposit or withdraw.",
  },
  pool: {
    title: "Pool",
    body: "A pool is a live BSV output. Its contract holds the token and BSV reserves, the LP key, the validator key and the fee terms. A swap advances the pool to a new output; closing it returns the funds to the LP.",
  },
  instance: {
    title: "Token instance",
    body: "One instance serves each enabled token. It runs the token's validator, relay and public lookup at its own address. It is not a global exchange database; other hosts can run their own instances.",
  },
  peers: {
    title: "Peer overlay",
    body: "The peer overlay is how hosts and instances announce and sync transactions and proofs. It is a gossip network, not a central server. The BSV chain remains the final arbiter.",
  },
  chain: {
    title: "BSV chain",
    body: "The BSV chain is the settlement layer. Pools, swaps and fees are ordinary transactions. Confirmation is what makes a swap final; the overlay only carries the proof.",
  },
};

const steps = [
  {
    title: "Custody stays with you",
    body: "Your wallet holds the sats and tokens. Nothing is deposited to the exchange, so there is no exchange balance to withdraw.",
    nodes: ["wallet"],
    edges: [],
  },
  {
    title: "Find a live pool",
    body: "The token instance's public lookup lists pools whose validator affirmation verifies, with their reserves and prices. Anyone can query it.",
    nodes: ["wallet", "pool", "instance"],
    edges: ["instance-pool"],
  },
  {
    title: "Build the swap",
    body: "Your wallet builds an ordinary BSV transaction. It spends your asset and the pool's output and names the payout keys. The pool contract enforces the pricing formula.",
    nodes: ["wallet", "pool"],
    edges: ["wallet-pool"],
  },
  {
    title: "Validator checks and signs",
    body: "The validator checks the pool state, its own fee terms and the transaction, then signs the pool input. The taker signs the rest; the validator signs last.",
    nodes: ["instance", "pool"],
    edges: ["instance-pool"],
  },
  {
    title: "Carry and announce",
    body: "The relay sends the signed transaction to the validator the taker named. The validator submits it to the token's overlay topic, where other hosts can verify and sync it.",
    nodes: ["wallet", "instance", "peers"],
    edges: ["wallet-instance", "instance-peers"],
  },
  {
    title: "Verify and sync",
    body: "Peers check the transaction against the token's rules and exchange proofs. A transaction that does not fit is refused; no single server has to be trusted for this.",
    nodes: ["peers", "chain"],
    edges: ["peers-chain"],
  },
  {
    title: "Settle and pay out",
    body: "On confirmation the pool advances to a new output. The taker's payout is locked to their wallet, and the LP, validator and relay fees are paid in the input asset.",
    nodes: ["chain", "pool", "wallet"],
    edges: ["pool-chain", "wallet-pool"],
  },
];

const nodeEls = {};
for (const el of document.querySelectorAll("[data-node]")) {
  (nodeEls[el.dataset.node] ??= []).push(el);
}

const edgeEls = {};
for (const el of document.querySelectorAll("[data-edge]")) {
  edgeEls[el.dataset.edge] = el;
}

const infoTitle = document.getElementById("info-title");
const infoBody = document.getElementById("info-body");

function showInfo(key) {
  const entry = info[key];
  if (!entry) return;
  infoTitle.textContent = entry.title;
  infoBody.textContent = entry.body;
  for (const [name, els] of Object.entries(nodeEls)) {
    for (const el of els) el.classList.toggle("selected", name === key);
  }
}

for (const els of Object.values(nodeEls)) {
  for (const el of els) {
    el.addEventListener("click", () => showInfo(el.dataset.node));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showInfo(el.dataset.node);
      }
    });
  }
}

const stepCount = document.getElementById("step-count");
const stepTitle = document.getElementById("step-title");
const stepBody = document.getElementById("step-body");
const dotsEl = document.getElementById("dots");

const dots = steps.map((_, index) => {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "dot";
  dot.setAttribute("aria-label", `Step ${index + 1}`);
  dot.addEventListener("click", () => setStep(index));
  dotsEl.appendChild(dot);
  return dot;
});

let current = 0;

function setStep(index) {
  current = (index + steps.length) % steps.length;
  const step = steps[current];

  for (const [name, els] of Object.entries(nodeEls)) {
    for (const el of els) {
      el.classList.toggle("active", step.nodes.includes(name));
    }
  }

  for (const [name, el] of Object.entries(edgeEls)) {
    el.classList.toggle("active", step.edges.includes(name));
  }

  stepCount.textContent = `Step ${current + 1} of ${steps.length}`;
  stepTitle.textContent = step.title;
  stepBody.textContent = step.body;

  dots.forEach((dot, i) => {
    dot.classList.toggle("active", i === current);
    dot.setAttribute("aria-current", i === current ? "step" : "false");
  });
}

document.getElementById("prev").addEventListener("click", () => setStep(current - 1));
document.getElementById("next").addEventListener("click", () => setStep(current + 1));

setStep(0);
