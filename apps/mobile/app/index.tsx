import { PROTOCOL_VERSION } from "@masscode/contracts";
import { Card } from "heroui-native";
import { View } from "react-native";

export default function Home() {
  return (
    <View className="flex-1 justify-center bg-background p-6">
      <Card>
        <Card.Body>
          <Card.Title>MassCode</Card.Title>
          <Card.Description>Protocol v{PROTOCOL_VERSION}</Card.Description>
        </Card.Body>
      </Card>
    </View>
  );
}
