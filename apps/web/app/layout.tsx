import { Bricolage_Grotesque, Inter } from "next/font/google";
import { BoardProvider } from "@/lib/board-context";
import { TopBar } from "@/components/TopBar";
import "./globals.css";

const displayFont = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display" });
const bodyFont = Inter({ subsets: ["latin"], variable: "--font-body" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <BoardProvider>
          <TopBar />
          {children}
        </BoardProvider>
      </body>
    </html>
  );
}
