import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ultra Super Party Passport",
  description: "The social universe + your passport to it",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
