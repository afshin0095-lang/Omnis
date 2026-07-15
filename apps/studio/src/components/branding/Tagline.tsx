import { motion } from "motion/react";

export default function Tagline() {
  return (
    <motion.p
      className="welcome-subtitle"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        delay: 0.35,
        duration: 0.8,
      }}
    >
      Future Starts Today
    </motion.p>
  );
}