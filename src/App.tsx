import { Route, Routes } from "react-router-dom";
import Home from "./routes/Home";
import AdminLogin from "./routes/AdminLogin";
import Admin from "./routes/Admin";
import OperatorLogin from "./routes/OperatorLogin";
import Booth from "./routes/Booth";
import Queue from "./routes/Queue";
import Wall from "./routes/Wall";
import Guest from "./routes/Guest";
import NotFound from "./routes/NotFound";

/** Role-based routes, one PWA. Each station opens the URL for its job and installs it. */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/operator/login" element={<OperatorLogin />} />
      <Route path="/booth" element={<Booth />} />
      <Route path="/queue" element={<Queue />} />
      <Route path="/wall/:slug" element={<Wall />} />
      <Route path="/guest" element={<Guest />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
