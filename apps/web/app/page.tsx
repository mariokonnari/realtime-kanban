import { BoardProvider } from "@/lib/board-context";
import { Board } from "@/components/Board";

export default function Home() {
  return (
    <BoardProvider>
      <Board />
    </BoardProvider>
  );
}
