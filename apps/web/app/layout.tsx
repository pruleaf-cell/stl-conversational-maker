import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STL Conversational Maker",
  description:
    "Generate print-ready STL and 3MF files from natural-language prompts."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
