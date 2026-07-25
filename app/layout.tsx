import type { Metadata } from "next";
import { Hedvig_Letters_Serif, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/* The single app typeface. Weights stop at 600 — semibold is the heaviest step
 * in the system, so no surface can reach for a 700 it hasn't earned. */
const jakarta = Plus_Jakarta_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--usp-jakarta",
});

/* The display / human voice — group inscriptions and the focused-name echo, and
 * nothing else. Carried over from the pepl design, where the serif is what makes
 * a name read as a person rather than a label. */
const hedvig = Hedvig_Letters_Serif({
  weight: ["400"],
  subsets: ["latin"],
  display: "swap",
  variable: "--usp-hedvig",
});

export const metadata: Metadata = {
  title: "Ultra Super Party Passport",
  description: "The social universe + your passport to it",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${hedvig.variable}`}>
      <body>{children}</body>
    </html>
  );
}
